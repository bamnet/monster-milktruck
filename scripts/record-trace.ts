import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAndServeApp, launchPlaywrightBrowser, loadEnvIfNeeded } from '../e2e/helpers.ts';
import { PRESETS } from '../src/config.ts';
import type { TerrainTrace, TraceFrame } from '../src/trace-types.ts';

loadEnvIfNeeded();

const TARGET_PRESETS = ['Whistler', 'San Francisco'] as const;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
  const outDir = join(process.cwd(), 'testdata', 'traces');
  mkdirSync(outDir, { recursive: true });

  const app = await buildAndServeApp(apiKey);
  const browser = await launchPlaywrightBrowser(headless);
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });

  try {
    await page.goto(app.url);
    await page.waitForFunction(
      (expectedPresets: number) =>
        Boolean(
          document.querySelector('gmp-map-3d') &&
            document.querySelector('gmp-model-3d') &&
            document.querySelectorAll('#presets button').length === expectedPresets,
        ),
      PRESETS.length,
      { timeout: 20_000 },
    );

    for (const label of TARGET_PRESETS) {
      const preset = PRESETS.find((p) => p.label === label);
      if (!preset) throw new Error(`Preset not found: ${label}`);

      console.log(`Recording trace for ${label}...`);
      await page.locator('#presets button', { hasText: label }).click();

      await page.waitForFunction(
        (target: { lat: number; lng: number }) => {
          const c = (document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement)
            .center as google.maps.LatLngAltitude;
          return (
            Math.abs(c.lat - target.lat) < 0.002 &&
            Math.abs(c.lng - target.lng) < 0.002 &&
            Math.abs(c.altitude ?? 0) > 1
          );
        },
        { lat: preset.lat, lng: preset.lng },
        { timeout: 15_000 },
      );
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const win = window as unknown as {
          __traceFrames: TraceFrame[];
          __traceInput: { left: boolean; right: boolean; gas: boolean; reverse: boolean };
          __traceActive: boolean;
        };
        win.__traceFrames = [];
        win.__traceInput = { left: false, right: false, gas: false, reverse: false };
        win.__traceActive = true;
        let lastT = performance.now();
        const t0 = lastT;
        const sample = (now: number) => {
          if (!win.__traceActive) return;
          const dt = Math.min((now - lastT) / 1000, 0.25);
          lastT = now;
          if (dt > 0) {
            const pos = model.position as google.maps.LatLngAltitude;
            const center = map.center as google.maps.LatLngAltitude;
            win.__traceFrames.push({
              tMs: Math.round((now - t0) * 10) / 10,
              dt: Math.round(dt * 1e5) / 1e5,
              input: { ...win.__traceInput },
              modelPos: {
                lat: Math.round(pos.lat * 1e7) / 1e7,
                lng: Math.round(pos.lng * 1e7) / 1e7,
              },
              mapCenter: {
                lat: Math.round(center.lat * 1e7) / 1e7,
                lng: Math.round(center.lng * 1e7) / 1e7,
                altitude: Math.round((center.altitude ?? 0) * 100) / 100,
              },
              mapRange: Math.round((map.range ?? 55) * 100) / 100,
              mapHeading: Math.round((map.heading ?? 0) * 100) / 100,
            });
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
