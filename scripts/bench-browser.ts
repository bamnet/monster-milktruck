import { appendFileSync } from 'node:fs';
import { buildAndServeApp, launchPlaywrightBrowser, loadEnvIfNeeded } from '../e2e/helpers.ts';
import { PRESETS } from '../src/config.ts';

loadEnvIfNeeded();

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
  maxTrackingOffsetM: number;
  maxFrameJitterM: number;
}

const BENCH_PRESETS = ['Whistler', 'San Francisco', 'Tokyo'] as const;

function resolveHeadlessFlag(): boolean {
  if (process.argv.includes('--headless')) return true;
  if (process.argv.includes('--headed')) return false;
  if (process.env.CI) return true;
  const hasDisplay = Boolean(
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin',
  );
  return !hasDisplay;
}

// Benchmarks frame-time smoothness and public Google Maps 3D JS API update rates:
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!apiKey) {
    console.warn('[bench:browser] GOOGLE_MAPS_API_KEY is not set; skipping browser benchmark report.');
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

      await page.evaluate(() => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const win = window as unknown as {
          __bench: { flyCalls: number; posWrites: number; oriWrites: number; longTasks: number };
        };
        win.__bench = { flyCalls: 0, posWrites: 0, oriWrites: 0, longTasks: 0 };

        const origFly = map.flyCameraTo.bind(map);
        map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
          win.__bench.flyCalls++;
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
      });

      const preset = PRESETS.find((p) => p.label === label)!;
      await page.locator('#presets button', { hasText: label }).click();

      await page.waitForFunction(
        (target: { lat: number; lng: number }) => {
          const c = (document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement)
            .center as google.maps.LatLngAltitude;
          return Math.abs(c.lat - target.lat) < 0.001 && Math.abs(c.lng - target.lng) < 0.001;
        },
        { lat: preset.lat, lng: preset.lng },
        { timeout: 15_000 },
      );
      await page.waitForTimeout(1_200);

      await page.evaluate(() => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const win = window as unknown as {
          __bench: { flyCalls: number; posWrites: number; oriWrites: number; longTasks: number };
          __runActive: boolean;
          __runData: {
            frameDeltas: number[];
            samples: Array<{ mLat: number; mLng: number; cLat: number; cLng: number }>;
            startMs: number;
          };
        };
        win.__bench.flyCalls = 0;
        win.__bench.posWrites = 0;
        win.__bench.oriWrites = 0;
        win.__bench.longTasks = 0;

        const frameDeltas: number[] = [];
        const samples: Array<{ mLat: number; mLng: number; cLat: number; cLng: number }> = [];
        win.__runActive = true;
        win.__runData = { frameDeltas, samples, startMs: performance.now() };
        let prev = performance.now();

        const tick = (now: number) => {
          if (!win.__runActive) return;
          frameDeltas.push(now - prev);
          prev = now;
          const pos = model.position as google.maps.LatLngAltitude;
          const center = map.center as google.maps.LatLngAltitude;
          samples.push({
            mLat: pos.lat,
            mLng: pos.lng,
            cLat: center.lat,
            cLng: center.lng,
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

      const m = await page.evaluate<Omit<ScenarioMetrics, 'preset'>>(() => {
        const win = window as unknown as {
          __bench: { flyCalls: number; posWrites: number; oriWrites: number; longTasks: number };
          __runActive: boolean;
          __runData: {
            frameDeltas: number[];
            samples: Array<{ mLat: number; mLng: number; cLat: number; cLng: number }>;
            startMs: number;
          };
        };
        win.__runActive = false;
        const { frameDeltas, samples, startMs } = win.__runData;
        const durationSec = Math.max((performance.now() - startMs) / 1000, 0.001);
        const sorted = [...frameDeltas].sort((a, b) => a - b);
        const n = sorted.length;
        const p50Ms = n ? (sorted[Math.floor(n * 0.5)] ?? 0) : 0;
        const p95Ms = n ? (sorted[Math.floor(n * 0.95)] ?? 0) : 0;
        const maxMs = n ? (sorted[n - 1] ?? 0) : 0;
        const droppedOver25Ms = frameDeltas.filter((d) => d > 25).length;

        const distM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
          const k = 111_319.9;
          const dN = (bLat - aLat) * k;
          const dE = (bLng - aLng) * k * Math.cos(((aLat + bLat) * 0.5 * Math.PI) / 180);
          return Math.hypot(dE, dN);
        };

        let maxTrackingOffsetM = 0;
        let maxFrameJitterM = 0;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i]!;
          const off = distM(s.mLat, s.mLng, s.cLat, s.cLng);
          if (off > maxTrackingOffsetM) maxTrackingOffsetM = off;
          if (i > 0) {
            const p = samples[i - 1]!;
            const k = 111_319.9;
            const cos = Math.cos(((s.mLat + p.mLat) * 0.5 * Math.PI) / 180);
            const mN = (s.mLat - p.mLat) * k;
            const mE = (s.mLng - p.mLng) * k * cos;
            const cN = (s.cLat - p.cLat) * k;
            const cE = (s.cLng - p.cLng) * k * cos;
            const jitter = Math.hypot(cE - mE, cN - mN);
            if (jitter > maxFrameJitterM) maxFrameJitterM = jitter;
          }
        }

        return {
          durationSec,
          frames: n,
          fps: n / durationSec,
          p50Ms,
          p95Ms,
          maxMs,
          droppedOver25Ms,
          longTasks: win.__bench.longTasks,
          flyPerSec: win.__bench.flyCalls / durationSec,
          posWritesPerSec: win.__bench.posWrites / durationSec,
          oriWritesPerSec: win.__bench.oriWrites / durationSec,
          maxTrackingOffsetM,
          maxFrameJitterM,
        };
      });

      results.push({ preset: label, ...m });
    }
  } finally {
    await browser.close();
    await app.close();
  }

  const lines: string[] = [
    `## Browser Smoothness & Frame-Time Report (${modeLabel}, advisory)`,
    '',
    '| Preset | FPS | rAF p50 (ms) | rAF p95 (ms) | rAF Max (ms) | >25ms Frames | LongTasks | `flyCameraTo`/s | `pos`/s | `ori`/s | Max Cam Offset (m) | Max Frame Jitter (m) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(
      (r) =>
        `| ${r.preset} | ${r.fps.toFixed(1)} | ${r.p50Ms.toFixed(1)} | ${r.p95Ms.toFixed(1)} | ${r.maxMs.toFixed(1)} | ${r.droppedOver25Ms} | ${r.longTasks} | ${r.flyPerSec.toFixed(1)} | ${r.posWritesPerSec.toFixed(1)} | ${r.oriWritesPerSec.toFixed(1)} | ${r.maxTrackingOffsetM.toFixed(1)} | ${r.maxFrameJitterM.toFixed(2)} |`,
    ),
  ];

  const markdown = `${lines.join('\n')}\n`;
  console.log(`\n${markdown}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `\n${markdown}`);
  }
}

await main();
