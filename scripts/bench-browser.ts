import { appendFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { buildAndServeApp, launchPlaywrightBrowser, loadEnvIfNeeded } from '../e2e/helpers.ts';
import { PRESETS } from '../src/config.ts';
import { degToRad, EARTH_RADIUS_M, fixAngle, offsetToLatLng } from '../src/math3d.ts';
import {
  computeSmoothnessMetrics,
  type SmoothnessMetrics,
  type SmoothnessSample,
} from '../src/smoothness.ts';
import type { LatLngAlt, Orientation3D } from '../src/trace-types.ts';

loadEnvIfNeeded();

const DEFAULT_CAM_TILT_DEG = 72;
const DEFAULT_CAM_RANGE_M = 55;
const BENCH_PRESETS = ['Whistler', 'San Francisco', 'Tokyo'] as const;

interface RawBrowserSample {
  tMs: number;
  dtS: number;
  modelPos: LatLngAlt;
  modelOri: Orientation3D;
  camPos?: LatLngAlt;
  mapCenter: LatLngAlt;
  mapHeading: number;
  mapTilt: number;
  mapRange: number;
  targetRange: number;
  targetAltOffset: number;
}

interface RawBenchCapture {
  durationSec: number;
  frameDeltas: number[];
  samples: RawBrowserSample[];
  flyCalls: number;
  posWrites: number;
  oriWrites: number;
  longTasks: number;
}

interface ScenarioMetrics {
  preset: string;
  durationSec: number;
  frames: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  droppedOver25Ms: number;
  longTasks: number;
  flyPerSec: number;
  posWritesPerSec: number;
  oriWritesPerSec: number;
  lagEyeP95M: number;
  lagEyeMaxM: number;
  eyeZeroSpikes: number;
  groundAltSpanM: number;
  rawCenterMaxOffsetM: number;
  minMapRangeM: number;
  smoothness: SmoothnessMetrics;
}

function resolveHeadlessFlag(): boolean {
  if (process.argv.includes('--headless')) return true;
  if (process.argv.includes('--headed')) return false;
  if (process.env.CI) return true;
  const hasDisplay = Boolean(
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin',
  );
  return !hasDisplay;
}

function horizDistM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dN = degToRad(b.lat - a.lat) * EARTH_RADIUS_M;
  const dE =
    degToRad(fixAngle(b.lng - a.lng)) * EARTH_RADIUS_M * Math.cos(degToRad((a.lat + b.lat) / 2));
  return Math.hypot(dE, dN);
}

function nearestRankPercentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.max(0, Math.min(n - 1, Math.ceil(n * p) - 1));
  return sorted[idx] ?? 0;
}

function projectCameraTarget(
  camPos: LatLngAlt,
  headingDeg: number,
  tiltDeg: number,
  rangeM: number,
  camAltOffsetM: number,
): { lat: number; lng: number; groundAlt: number } {
  const tiltRad = degToRad(tiltDeg);
  const hRad = degToRad(headingDeg);
  const horizM = rangeM * Math.sin(tiltRad);
  const target = offsetToLatLng(
    camPos.lat,
    camPos.lng,
    horizM * Math.sin(hRad),
    horizM * Math.cos(hRad),
  );
  const groundAlt = camPos.altitude - rangeM * Math.cos(tiltRad) - camAltOffsetM;
  return { lat: target.lat, lng: target.lng, groundAlt };
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

  // Wait for the initial 3D scene steady event (with timeout guard if already steady).
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

function summarizeCapture(preset: string, capture: RawBenchCapture): ScenarioMetrics {
  const { durationSec, frameDeltas, samples } = capture;
  const sortedDeltas = [...frameDeltas].sort((a, b) => a - b);
  const n = sortedDeltas.length;
  const p50Ms = nearestRankPercentile(sortedDeltas, 0.5);
  const p95Ms = nearestRankPercentile(sortedDeltas, 0.95);
  const maxMs = n ? (sortedDeltas[n - 1] ?? 0) : 0;
  const droppedOver25Ms = frameDeltas.filter((d) => d > 25).length;

  const lagEyeSamples: number[] = [];
  let eyeZeroSpikes = 0;
  let minGroundAlt = Infinity;
  let maxGroundAlt = -Infinity;
  let rawCenterMaxOffsetM = 0;
  let minMapRangeM = Infinity;
  const smoothnessSamples: SmoothnessSample[] = [];

  for (const s of samples) {
    const rawCenterOff = horizDistM(s.modelPos, s.mapCenter);
    if (rawCenterOff > rawCenterMaxOffsetM) rawCenterMaxOffsetM = rawCenterOff;
    if (Number.isFinite(s.mapRange) && s.mapRange < minMapRangeM) {
      minMapRangeM = s.mapRange;
    }

    let camLat: number | undefined;
    let camLng: number | undefined;
    let camAlt: number | undefined;
    let groundAlt: number | undefined;

    if (s.camPos) {
      camAlt = s.camPos.altitude;
      if (Math.abs(s.camPos.altitude) < 0.01) {
        eyeZeroSpikes++;
      } else {
        const projected = projectCameraTarget(
          s.camPos,
          s.mapHeading,
          s.mapTilt,
          s.targetRange,
          s.targetAltOffset,
        );
        camLat = projected.lat;
        camLng = projected.lng;
        groundAlt = projected.groundAlt;
        lagEyeSamples.push(horizDistM(s.modelPos, projected));
        if (groundAlt < minGroundAlt) minGroundAlt = groundAlt;
        if (groundAlt > maxGroundAlt) maxGroundAlt = groundAlt;
      }
    }

    const modelAlt = groundAlt !== undefined ? groundAlt + s.modelPos.altitude : s.modelPos.altitude;
    smoothnessSamples.push({
      tMs: s.tMs,
      dtS: s.dtS,
      modelLat: s.modelPos.lat,
      modelLng: s.modelPos.lng,
      modelAlt,
      headingDeg: s.modelOri.heading,
      tiltDeg: s.modelOri.tilt,
      rollDeg: s.modelOri.roll,
      camLat,
      camLng,
      camAlt,
      groundAlt,
    });
  }

  lagEyeSamples.sort((a, b) => a - b);
  const lagEyeP95M = nearestRankPercentile(lagEyeSamples, 0.95);
  const lagEyeMaxM = lagEyeSamples.length ? (lagEyeSamples[lagEyeSamples.length - 1] ?? 0) : 0;

  return {
    preset,
    durationSec,
    frames: n,
    fps: n / durationSec,
    p50Ms,
    p95Ms,
    maxMs,
    droppedOver25Ms,
    longTasks: capture.longTasks,
    flyPerSec: capture.flyCalls / durationSec,
    posWritesPerSec: capture.posWrites / durationSec,
    oriWritesPerSec: capture.oriWrites / durationSec,
    lagEyeP95M,
    lagEyeMaxM,
    eyeZeroSpikes,
    groundAltSpanM: Number.isFinite(minGroundAlt) ? maxGroundAlt - minGroundAlt : 0,
    rawCenterMaxOffsetM,
    minMapRangeM: Number.isFinite(minMapRangeM) ? minMapRangeM : 0,
    smoothness: computeSmoothnessMetrics(smoothnessSamples),
  };
}

// Benchmarks frame-time smoothness, cameraPosition eye tracking, and model tilt/roll
// smoothness against public Google Maps 3D JS API elements:
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!apiKey) {
    console.warn(
      '[bench:browser] GOOGLE_MAPS_API_KEY is not set; skipping browser benchmark report.',
    );
    return;
  }

  const headless = resolveHeadlessFlag();
  const modeLabel = headless ? 'headless software WebGL' : 'headed hardware GPU';
  console.log(`Running browser benchmark (${modeLabel})...`);

  const app = await buildAndServeApp(apiKey);
  const browser = await launchPlaywrightBrowser(headless);
  const page = await browser.newPage({
    viewport: headless ? { width: 640, height: 480 } : { width: 1280, height: 720 },
  });

  const results: ScenarioMetrics[] = [];

  try {
    for (const label of BENCH_PRESETS) {
      await page.goto(app.url);
      await waitForMapReady(page, PRESETS.length);

      await page.evaluate(
        ({ defaultTilt, defaultRange }) => {
          const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const win = window as unknown as {
            __bench: {
              flyCalls: number;
              posWrites: number;
              oriWrites: number;
              longTasks: number;
              lastTargetRange: number;
              lastTargetTilt: number;
              lastTargetHeading: number;
              lastTargetAltOffset: number;
              steadySeen: boolean;
              animEnded: boolean;
            };
          };
          win.__bench = {
            flyCalls: 0,
            posWrites: 0,
            oriWrites: 0,
            longTasks: 0,
            lastTargetRange: defaultRange,
            lastTargetTilt: defaultTilt,
            lastTargetHeading: Number.isFinite(map.heading) ? (map.heading ?? 0) : 0,
            lastTargetAltOffset: 0,
            steadySeen: false,
            animEnded: false,
          };

          map.addEventListener('gmp-steadychange', (e: Event) => {
            if ((e as Event & { isSteady?: boolean }).isSteady) {
              win.__bench.steadySeen = true;
            }
          });
          map.addEventListener('gmp-animationend', () => {
            win.__bench.animEnded = true;
          });

          const origFly = map.flyCameraTo.bind(map);
          map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
            win.__bench.flyCalls++;
            if (Number.isFinite(opts.endCamera.range)) {
              win.__bench.lastTargetRange = opts.endCamera.range!;
            }
            if (Number.isFinite(opts.endCamera.tilt)) {
              win.__bench.lastTargetTilt = opts.endCamera.tilt!;
            }
            if (Number.isFinite(opts.endCamera.heading)) {
              win.__bench.lastTargetHeading = opts.endCamera.heading!;
            }
            const c = opts.endCamera.center as google.maps.LatLngAltitudeLiteral | undefined;
            if (c && Number.isFinite(c.altitude)) {
              win.__bench.lastTargetAltOffset = c.altitude!;
            }
            return origFly(opts);
          };

          const proto = Object.getPrototypeOf(model);
          const posDesc = Object.getOwnPropertyDescriptor(proto, 'position');
          if (posDesc?.set && posDesc?.get) {
            Object.defineProperty(model, 'position', {
              configurable: true,
              get() {
                return posDesc.get!.call(this);
              },
              set(v) {
                win.__bench.posWrites++;
                posDesc.set!.call(this, v);
              },
            });
          }
          const oriDesc = Object.getOwnPropertyDescriptor(proto, 'orientation');
          if (oriDesc?.set && oriDesc?.get) {
            Object.defineProperty(model, 'orientation', {
              configurable: true,
              get() {
                return oriDesc.get!.call(this);
              },
              set(v) {
                win.__bench.oriWrites++;
                oriDesc.set!.call(this, v);
              },
            });
          }

          if (typeof PerformanceObserver !== 'undefined') {
            try {
              const obs = new PerformanceObserver((list) => {
                win.__bench.longTasks += list.getEntries().length;
              });
              obs.observe({ entryTypes: ['longtask'] });
            } catch {}
          }
        },
        { defaultTilt: DEFAULT_CAM_TILT_DEG, defaultRange: DEFAULT_CAM_RANGE_M },
      );

      const preset = PRESETS.find((p) => p.label === label)!;
      await page.evaluate(() => {
        const win = window as unknown as {
          __bench: { steadySeen: boolean; animEnded: boolean; teleportStartMs: number };
        };
        win.__bench.steadySeen = false;
        win.__bench.animEnded = false;
        win.__bench.teleportStartMs = performance.now();
      });
      await page.locator('#presets button', { hasText: label }).click();

      await page.waitForFunction(
        (target: { lat: number; lng: number }) => {
          const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
            cameraPosition?: google.maps.LatLngAltitude | null;
          };
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const pos = model.position as google.maps.LatLngAltitude | null;
          const win = window as unknown as {
            __bench: { steadySeen: boolean; animEnded: boolean; teleportStartMs: number };
          };
          const nearModel = Boolean(
            pos && Math.abs(pos.lat - target.lat) < 0.002 && Math.abs(pos.lng - target.lng) < 0.002,
          );
          const cp = map.cameraPosition;
          const nearEye = Boolean(
            cp &&
              Number.isFinite(cp.lat) &&
              Number.isFinite(cp.lng) &&
              Number.isFinite(cp.altitude) &&
              Math.abs(cp.lat - target.lat) < 0.01 &&
              Math.abs(cp.lng - target.lng) < 0.01 &&
              Math.abs(cp.altitude) >= 0.01,
          );
          const flightComplete =
            win.__bench.steadySeen ||
            win.__bench.animEnded ||
            performance.now() - win.__bench.teleportStartMs >= 1_500;
          return nearModel && nearEye && flightComplete;
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
            const win = window as unknown as { __bench: { steadySeen: boolean } };
            if (!map || map.isSteady === true || win.__bench.steadySeen) {
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
          __bench: {
            flyCalls: number;
            posWrites: number;
            oriWrites: number;
            longTasks: number;
            lastTargetRange: number;
            lastTargetTilt: number;
            lastTargetHeading: number;
            lastTargetAltOffset: number;
          };
          __runActive: boolean;
          __runData: {
            frameDeltas: number[];
            samples: RawBrowserSample[];
            startMs: number;
          };
        };
        win.__bench.flyCalls = 0;
        win.__bench.posWrites = 0;
        win.__bench.oriWrites = 0;
        win.__bench.longTasks = 0;

        const frameDeltas: number[] = [];
        const samples: RawBrowserSample[] = [];
        const startMs = performance.now();
        win.__runActive = true;
        win.__runData = { frameDeltas, samples, startMs };
        let prev = startMs;

        const tick = (now: number) => {
          if (!win.__runActive) return;
          const dtMs = now - prev;
          prev = now;
          frameDeltas.push(dtMs);

          // Explicitly read prototype getters into plain objects.
          const pos = model.position as google.maps.LatLngAltitude | null;
          const ori = model.orientation as google.maps.Orientation3D | null;
          const center = map.center as google.maps.LatLngAltitude | null;
          const cp = map.cameraPosition;

          const modelPos: LatLngAlt = {
            lat: pos?.lat ?? 0,
            lng: pos?.lng ?? 0,
            altitude: pos?.altitude ?? 0,
          };
          const modelOri: Orientation3D = {
            heading: ori?.heading ?? 0,
            tilt: ori?.tilt ?? 0,
            roll: ori?.roll ?? 0,
          };
          const mapCenter: LatLngAlt = {
            lat: center?.lat ?? 0,
            lng: center?.lng ?? 0,
            altitude: center?.altitude ?? 0,
          };
          const camPos: LatLngAlt | undefined =
            cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng) && Number.isFinite(cp.altitude)
              ? { lat: cp.lat, lng: cp.lng, altitude: cp.altitude }
              : undefined;

          samples.push({
            tMs: now - startMs,
            dtS: dtMs / 1000,
            modelPos,
            modelOri,
            camPos,
            mapCenter,
            mapHeading: Number.isFinite(map.heading)
              ? (map.heading as number)
              : win.__bench.lastTargetHeading,
            mapTilt: Number.isFinite(map.tilt)
              ? (map.tilt as number)
              : win.__bench.lastTargetTilt,
            mapRange: Number.isFinite(map.range)
              ? (map.range as number)
              : win.__bench.lastTargetRange,
            targetRange: win.__bench.lastTargetRange,
            targetAltOffset: win.__bench.lastTargetAltOffset,
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      // Scripted 4.5s drive: 2.0s straight, 1.5s right turn, 1.0s coast
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2_000);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(1_500);
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(1_000);

      const capture = await page.evaluate<RawBenchCapture>(() => {
        const win = window as unknown as {
          __bench: { flyCalls: number; posWrites: number; oriWrites: number; longTasks: number };
          __runActive: boolean;
          __runData: {
            frameDeltas: number[];
            samples: RawBrowserSample[];
            startMs: number;
          };
        };
        win.__runActive = false;
        const durationSec = Math.max((performance.now() - win.__runData.startMs) / 1000, 0.001);
        return {
          durationSec,
          frameDeltas: win.__runData.frameDeltas,
          samples: win.__runData.samples,
          flyCalls: win.__bench.flyCalls,
          posWrites: win.__bench.posWrites,
          oriWrites: win.__bench.oriWrites,
          longTasks: win.__bench.longTasks,
        };
      });

      results.push(summarizeCapture(label, capture));
    }
  } finally {
    await browser.close();
    await app.close();
  }

  const lines: string[] = [
    `## Browser Smoothness & Frame-Time Report (${modeLabel}, advisory)`,
    '',
    '### Frame-Time, API Rates & `cameraPosition` Tracking',
    '| Preset | FPS | rAF p50 / p95 / Max (ms) | >25ms | LongTasks | `fly`/s | `pos`/s | `ori`/s | `lagEye` p95 / Max (m) | 0m Spikes | Ground Span (m) | Raw Center Diag (m / minRange) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(
      (r) =>
        `| ${r.preset} | ${r.fps.toFixed(1)} | ${r.p50Ms.toFixed(1)} / ${r.p95Ms.toFixed(1)} / ${r.maxMs.toFixed(1)} | ${r.droppedOver25Ms} | ${r.longTasks} | ${r.flyPerSec.toFixed(1)} | ${r.posWritesPerSec.toFixed(1)} | ${r.oriWritesPerSec.toFixed(1)} | ${r.lagEyeP95M.toFixed(2)} / ${r.lagEyeMaxM.toFixed(2)} | ${r.eyeZeroSpikes} | ${r.groundAltSpanM.toFixed(1)} | ${r.rawCenterMaxOffsetM.toFixed(1)} / ${r.minMapRangeM.toFixed(1)} |`,
    ),
    '',
    '### Model Tilt, Roll & Vertical Smoothness (`computeSmoothnessMetrics`)',
    '| Preset | Samples | Max ΔTilt (°) | Max Tilt Rate (°/s) | p95 / Max Tilt Jerk (°/s³) | Tilt Flips | Max ΔRoll (°) | Max Roll Rate (°/s) | p95 / Max Roll Jerk (°/s³) | Roll Flips | Max ΔHdg (°) | Max ΔAlt (m) | Max V-Jerk (m/s³) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map((r) => {
      const sm = r.smoothness;
      return `| ${r.preset} | ${sm.sampleCount} | ${sm.maxTiltStepDeg.toFixed(2)} | ${sm.maxTiltRateDegS.toFixed(1)} | ${sm.p95TiltJerkDegS3.toFixed(0)} / ${sm.maxTiltJerkDegS3.toFixed(0)} | ${sm.tiltSignFlips} | ${sm.maxRollStepDeg.toFixed(2)} | ${sm.maxRollRateDegS.toFixed(1)} | ${sm.p95RollJerkDegS3.toFixed(0)} / ${sm.maxRollJerkDegS3.toFixed(0)} | ${sm.rollSignFlips} | ${sm.maxHeadingStepDeg.toFixed(2)} | ${sm.maxAltStepM.toFixed(2)} | ${sm.maxVerticalJerkMs3.toFixed(0)} |`;
    }),
  ];

  const markdown = `${lines.join('\n')}\n`;
  console.log(`\n${markdown}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `\n${markdown}`);
  }
}

await main();
