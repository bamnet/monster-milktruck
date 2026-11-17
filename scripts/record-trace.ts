import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { buildAndServeApp, launchPlaywrightBrowser, loadEnvIfNeeded } from '../e2e/helpers.ts';
import { PRESETS } from '../src/config.ts';
import type { LatLngAlt, Orientation3D, TerrainTrace, TraceFrame } from '../src/trace-types.ts';

loadEnvIfNeeded();

const DEFAULT_PRESETS = ['Whistler', 'San Francisco'] as const;
const DEFAULT_CAM_RANGE_M = 55;
const DEFAULT_CAM_TILT_DEG = 72;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseCliFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function waitForMapReady(page: Page, expectedPresets: number): Promise<void> {
  await page.waitForFunction(
    (count: number) => {
      if (!customElements.get('gmp-map-3d') || !customElements.get('gmp-model-3d')) {
        return false;
      }
      const map = document.querySelector('gmp-map-3d') as
        | (google.maps.maps3d.Map3DElement & { flyCameraTo?: unknown })
        | null;
      const model = document.querySelector('gmp-model-3d') as
        | google.maps.maps3d.Model3DElement
        | null;
      if (!map || !model || typeof map.flyCameraTo !== 'function') return false;
      const pos = model.position as google.maps.LatLngAltitude | null;
      return (
        Boolean(pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) &&
        document.querySelectorAll('#presets button').length === count
      );
    },
    expectedPresets,
    { timeout: 30_000 },
  );

  // Wait for the initial gmp-steadychange event so the 3D scene has settled.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = document.querySelector('gmp-map-3d') as
          | (google.maps.maps3d.Map3DElement & { isSteady?: boolean })
          | null;
        const loading = document.getElementById('loading-screen');
        if (!map || map.isSteady === true || loading?.hidden === true) {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          map.removeEventListener('gmp-steadychange', onSteady);
          resolve();
        }, 15_000);
        const onSteady = (e: Event) => {
          if ((e as Event & { isSteady?: boolean }).isSteady) {
            window.clearTimeout(timer);
            map.removeEventListener('gmp-steadychange', onSteady);
            resolve();
          }
        };
        map.addEventListener('gmp-steadychange', onSteady);
      }),
  );
}

// Records public Map3DElement (gmp-map-3d) and Model3DElement (gmp-model-3d) properties
// during a scripted drive for deterministic trace replay tests:
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is required to record terrain traces.');
  }

  const headless = !process.argv.includes('--headed');
  const presetsArg = parseCliFlag('presets');
  const targetPresets = presetsArg
    ? presetsArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_PRESETS];
  const outDir = parseCliFlag('out-dir') ?? join(process.cwd(), 'testdata', 'traces');
  mkdirSync(outDir, { recursive: true });

  const app = await buildAndServeApp(apiKey);
  const browser = await launchPlaywrightBrowser(headless);
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });

  try {
    await page.goto(app.url);
    await waitForMapReady(page, PRESETS.length);

    // Track target range & altitude offset from flyCameraTo so groundAltitude is exact.
    await page.evaluate(
      ({ defaultRange, defaultTilt }) => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const win = window as unknown as {
          __traceMeta: {
            targetRange: number;
            targetTilt: number;
            targetAltOffset: number;
            steadySeen: boolean;
            animEnded: boolean;
          };
        };
        win.__traceMeta = {
          targetRange: defaultRange,
          targetTilt: defaultTilt,
          targetAltOffset: 0,
          steadySeen: false,
          animEnded: false,
        };
        map.addEventListener('gmp-steadychange', (e: Event) => {
          if ((e as Event & { isSteady?: boolean }).isSteady) {
            win.__traceMeta.steadySeen = true;
          }
        });
        map.addEventListener('gmp-animationend', () => {
          win.__traceMeta.animEnded = true;
        });

        const origFly = map.flyCameraTo.bind(map);
        map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
          if (Number.isFinite(opts.endCamera.range)) {
            win.__traceMeta.targetRange = opts.endCamera.range!;
          }
          if (Number.isFinite(opts.endCamera.tilt)) {
            win.__traceMeta.targetTilt = opts.endCamera.tilt!;
          }
          const c = opts.endCamera.center as google.maps.LatLngAltitudeLiteral | undefined;
          if (c && Number.isFinite(c.altitude)) {
            win.__traceMeta.targetAltOffset = c.altitude!;
          }
          return origFly(opts);
        };
      },
      { defaultRange: DEFAULT_CAM_RANGE_M, defaultTilt: DEFAULT_CAM_TILT_DEG },
    );

    for (const label of targetPresets) {
      const preset = PRESETS.find((p) => p.label === label);
      if (!preset) throw new Error(`Preset not found: ${label}`);

      console.log(`Recording trace for ${label}...`);
      await page.evaluate(() => {
        const win = window as unknown as {
          __traceMeta: { steadySeen: boolean; animEnded: boolean; teleportStartMs: number };
        };
        win.__traceMeta.steadySeen = false;
        win.__traceMeta.animEnded = false;
        win.__traceMeta.teleportStartMs = performance.now();
      });
      await page.locator('#presets button', { hasText: label }).click();

      await page.waitForFunction(
        (target: { lat: number; lng: number }) => {
          const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
            cameraPosition?: google.maps.LatLngAltitude | null;
          };
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const pos = model.position as google.maps.LatLngAltitude | null;
          const cp = map.cameraPosition;
          const win = window as unknown as {
            __traceMeta: { steadySeen: boolean; animEnded: boolean; teleportStartMs: number };
          };
          const nearModel = Boolean(
            pos && Math.abs(pos.lat - target.lat) < 0.002 && Math.abs(pos.lng - target.lng) < 0.002,
          );
          const validCam = Boolean(
            cp &&
              Number.isFinite(cp.lat) &&
              Number.isFinite(cp.lng) &&
              Number.isFinite(cp.altitude) &&
              Math.abs(cp.lat - target.lat) < 0.01 &&
              Math.abs(cp.lng - target.lng) < 0.01 &&
              Math.abs(cp.altitude) >= 0.01,
          );
          const flightComplete =
            win.__traceMeta.steadySeen ||
            win.__traceMeta.animEnded ||
            performance.now() - win.__traceMeta.teleportStartMs >= 1_500;
          return nearModel && validCam && flightComplete;
        },
        { lat: preset.lat, lng: preset.lng },
        { timeout: 18_000 },
      );

      // Wait briefly for gmp-steadychange after teleport arrival (bounded for software WebGL).
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const map = document.querySelector('gmp-map-3d') as
              | (google.maps.maps3d.Map3DElement & { isSteady?: boolean })
              | null;
            const win = window as unknown as { __traceMeta: { steadySeen: boolean } };
            if (!map || map.isSteady === true || win.__traceMeta.steadySeen) {
              resolve();
              return;
            }
            const timer = window.setTimeout(() => {
              map.removeEventListener('gmp-steadychange', onSteady);
              resolve();
            }, 3_000);
            const onSteady = (e: Event) => {
              if ((e as Event & { isSteady?: boolean }).isSteady) {
                window.clearTimeout(timer);
                map.removeEventListener('gmp-steadychange', onSteady);
                resolve();
              }
            };
            map.addEventListener('gmp-steadychange', onSteady);
          }),
      );
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
          cameraPosition?: google.maps.LatLngAltitude | null;
        };
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const win = window as unknown as {
          __traceFrames: TraceFrame[];
          __traceInput: { left: boolean; right: boolean; gas: boolean; reverse: boolean };
          __traceActive: boolean;
          __traceMeta: { targetRange: number; targetTilt: number; targetAltOffset: number };
        };
        win.__traceFrames = [];
        win.__traceInput = { left: false, right: false, gas: false, reverse: false };
        win.__traceActive = true;

        const round7 = (v: number) => Math.round(v * 1e7) / 1e7;
        const round2 = (v: number) => Math.round(v * 100) / 100;

        let lastT = performance.now();
        const t0 = lastT;
        const sample = (now: number) => {
          if (!win.__traceActive) return;
          const dt = Math.min((now - lastT) / 1000, 0.25);
          lastT = now;
          if (dt > 0) {
            // Explicitly read prototype getters into plain JSON-serializable literals.
            const pos = model.position as google.maps.LatLngAltitude;
            const ori = model.orientation as google.maps.Orientation3D | null;
            const center = map.center as google.maps.LatLngAltitude;
            const cp = map.cameraPosition;

            const mapTilt = Number.isFinite(map.tilt)
              ? round2(map.tilt as number)
              : round2(win.__traceMeta.targetTilt);

            const cameraPosition: LatLngAlt | undefined =
              cp &&
              Number.isFinite(cp.lat) &&
              Number.isFinite(cp.lng) &&
              Number.isFinite(cp.altitude)
                ? { lat: round7(cp.lat), lng: round7(cp.lng), altitude: round2(cp.altitude) }
                : undefined;

            const modelOrientation: Orientation3D | undefined =
              ori &&
              Number.isFinite(ori.heading) &&
              Number.isFinite(ori.tilt) &&
              Number.isFinite(ori.roll)
                ? {
                    heading: round2(ori.heading),
                    tilt: round2(ori.tilt),
                    roll: round2(ori.roll),
                  }
                : undefined;

            const groundAltitude =
              cameraPosition && Math.abs(cameraPosition.altitude) >= 0.01
                ? round2(
                    cameraPosition.altitude -
                      win.__traceMeta.targetRange * Math.cos((mapTilt * Math.PI) / 180) -
                      win.__traceMeta.targetAltOffset,
                  )
                : undefined;

            const frame: TraceFrame = {
              tMs: Math.round((now - t0) * 10) / 10,
              dt: Math.round(dt * 1e5) / 1e5,
              input: { ...win.__traceInput },
              modelPos: {
                lat: round7(pos.lat),
                lng: round7(pos.lng),
                altitude: round2(pos.altitude ?? 0),
              },
              mapCenter: {
                lat: round7(center.lat),
                lng: round7(center.lng),
                altitude: round2(center.altitude ?? 0),
              },
              mapRange: round2(map.range ?? win.__traceMeta.targetRange),
              mapHeading: round2(map.heading ?? 0),
              mapTilt,
              ...(cameraPosition ? { cameraPosition } : {}),
              ...(modelOrientation ? { modelOrientation } : {}),
              ...(groundAltitude !== undefined ? { groundAltitude } : {}),
            };
            win.__traceFrames.push(frame);
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });

      // Phase 1: accelerate straight (2.2s)
      await page.evaluate(() => {
        (window as unknown as { __traceInput: { gas: boolean } }).__traceInput.gas = true;
      });
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2_200);

      // Phase 2: steer right while accelerating (1.3s)
      await page.evaluate(() => {
        (window as unknown as { __traceInput: { right: boolean } }).__traceInput.right = true;
      });
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(1_300);

      // Phase 3: release and coast (1.2s)
      await page.evaluate(() => {
        const win = window as unknown as {
          __traceInput: { gas: boolean; right: boolean };
        };
        win.__traceInput.gas = false;
        win.__traceInput.right = false;
      });
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(1_200);

      const frames = await page.evaluate<TraceFrame[]>(() => {
        const win = window as unknown as {
          __traceActive: boolean;
          __traceFrames: TraceFrame[];
        };
        win.__traceActive = false;
        return win.__traceFrames;
      });

      const trace: TerrainTrace = {
        preset: label,
        start: { lat: preset.lat, lng: preset.lng, heading: preset.heading },
        capturedAt: new Date().toISOString().slice(0, 10),
        frames,
      };

      const filePath = join(outDir, `${slugify(label)}.json`);
      writeFileSync(filePath, `${JSON.stringify(trace, null, 2)}\n`);
      console.log(`  Wrote ${frames.length} frames to ${filePath}`);
    }
  } finally {
    await browser.close();
    await app.close();
  }
}

await main();
