import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { horizontalDistanceM } from '../src/math3d.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json; charset=utf-8',
};

export function loadEnvIfNeeded(): void {
  if (process.env.GOOGLE_MAPS_API_KEY) return;
  for (const name of ['.env.local', '.env']) {
    const path = join(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

export interface AppServer {
  url: string;
  port: number;
  outdir: string;
  close(): Promise<void>;
}

export async function buildAndServeApp(apiKey: string): Promise<AppServer> {
  const outdir = mkdtempSync(join(tmpdir(), 'milktruck-dist-'));
  try {
    execFileSync(
      'bun',
      [
        '-e',
        `
        const res = await Bun.build({
          entrypoints: ['./index.html'],
          outdir: process.env.BUILD_OUTDIR,
          minify: true,
          publicPath: './',
          env: 'disable',
          naming: { asset: '[name]-[hash].[ext]' },
          define: {
            'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify(process.env.BUILD_API_KEY ?? ''),
            'process.env.NODE_ENV': JSON.stringify('production'),
          },
        });
        if (!res.success) {
          console.error(res.logs);
          process.exit(1);
        }
        `,
      ],
      {
        env: { ...process.env, BUILD_OUTDIR: outdir, BUILD_API_KEY: apiKey },
        stdio: 'pipe',
      },
    );
  } catch (err) {
    rmSync(outdir, { recursive: true, force: true });
    throw err;
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const relPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = join(outdir, relPath);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://localhost:${port}`,
    port,
    outdir,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(outdir, { recursive: true, force: true });
    },
  };
}

export function resolveChromeChannel(): 'chrome' | undefined {
  if (
    existsSync('/usr/bin/google-chrome') ||
    existsSync('/usr/bin/google-chrome-stable') ||
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ) {
    return 'chrome';
  }
  return undefined;
}

export function getWebGlArgs(headless: boolean): string[] {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (headless) {
    args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  return args;
}

export async function launchPlaywrightBrowser(headless = true): Promise<Browser> {
  return chromium.launch({
    channel: resolveChromeChannel(),
    headless,
    args: getWebGlArgs(headless),
  });
}

export function attachErrorTracking(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('favicon.ico')) {
        errors.push(`console.error: ${text}`);
      }
    }
  });
  return errors;
}

export function horizontalDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  return horizontalDistanceM(a, b);
}

/**
 * Waits for `gmp-map-3d` and `gmp-model-3d` custom elements to upgrade, mount
 * the initial model position, render preset buttons, and fire initial
 * `gmp-steadychange` (bounded by timeout for headless software WebGL).
 */
export async function waitForMapReadyAndSteady(
  page: Page,
  expectedPresets: number,
): Promise<void> {
  // Capture initial gmp-steadychange as early as possible so we detect if it
  // fires while waiting for custom elements, without confusing the 8 s loading
  // fallback timeout for true scene steadiness.
  await page.evaluate(() => {
    const win = window as unknown as {
      __initialSteadySeen?: boolean;
      __initialSteadyListening?: boolean;
    };
    if (win.__initialSteadyListening) return;
    win.__initialSteadyListening = true;
    const onDocSteady = (e: Event) => {
      if ((e as Event & { isSteady?: boolean }).isSteady) {
        win.__initialSteadySeen = true;
        document.removeEventListener('gmp-steadychange', onDocSteady, true);
      }
    };
    document.addEventListener('gmp-steadychange', onDocSteady, true);
  });

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
    { timeout: 25_000 },
  );

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const win = window as unknown as { __initialSteadySeen?: boolean };
        const map = document.querySelector('gmp-map-3d') as
          | (google.maps.maps3d.Map3DElement & { isSteady?: boolean })
          | null;
        if (!map || map.isSteady === true || win.__initialSteadySeen === true) {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          map.removeEventListener('gmp-steadychange', onSteady);
          resolve();
        }, 15_000);
        const onSteady = (e: Event) => {
          if ((e as Event & { isSteady?: boolean }).isSteady) {
            win.__initialSteadySeen = true;
            window.clearTimeout(timer);
            map.removeEventListener('gmp-steadychange', onSteady);
            resolve();
          }
        };
        map.addEventListener('gmp-steadychange', onSteady);
      }),
  );
}

/**
 * Clicks a preset button to teleport, waits for model and camera eye arrival,
 * waits for `gmp-steadychange` / teleport lock expiry, and lets terrain settle.
 */
export async function teleportToPresetAndWaitSteady(
  page: Page,
  preset: { label: string; lat: number; lng: number },
): Promise<void> {
  await page.evaluate((target: { lat: number; lng: number }) => {
    const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
      cameraPosition?: google.maps.LatLngAltitude | null;
    };
    const win = window as unknown as {
      __teleportState?: {
        steadySeen: boolean;
        animEnded: boolean;
        startMs: number;
        cleanup: () => void;
      };
    };
    win.__teleportState?.cleanup();
    const state = {
      steadySeen: false,
      animEnded: false,
      startMs: performance.now(),
      cleanup: () => {},
    };
    const onSteady = (e: Event) => {
      if (!(e as Event & { isSteady?: boolean }).isSteady) return;
      const cp = map.cameraPosition;
      if (
        cp &&
        Number.isFinite(cp.lat) &&
        Number.isFinite(cp.lng) &&
        Math.abs(cp.lat - target.lat) < 0.002 &&
        Math.abs(cp.lng - target.lng) < 0.002
      ) {
        state.steadySeen = true;
      }
    };
    const onAnimEnd = () => {
      state.animEnded = true;
    };
    map.addEventListener('gmp-steadychange', onSteady);
    map.addEventListener('gmp-animationend', onAnimEnd);
    state.cleanup = () => {
      map.removeEventListener('gmp-steadychange', onSteady);
      map.removeEventListener('gmp-animationend', onAnimEnd);
    };
    win.__teleportState = state;
  }, { lat: preset.lat, lng: preset.lng });

  await page.locator('#presets button', { hasText: preset.label }).click();

  await page.waitForFunction(
    (target: { lat: number; lng: number }) => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
        cameraPosition?: google.maps.LatLngAltitude | null;
      };
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const pos = model.position as google.maps.LatLngAltitude | null;
      const cp = map.cameraPosition;
      const win = window as unknown as {
        __teleportState?: { steadySeen: boolean; animEnded: boolean; startMs: number };
      };
      const st = win.__teleportState;
      const elapsed = st ? performance.now() - st.startMs : 0;
      const nearModel = Boolean(
        pos && Math.abs(pos.lat - target.lat) < 0.002 && Math.abs(pos.lng - target.lng) < 0.002,
      );
      const nearEye = Boolean(
        cp &&
          Number.isFinite(cp.lat) &&
          Number.isFinite(cp.lng) &&
          Number.isFinite(cp.altitude) &&
          Math.abs(cp.lat - target.lat) < 0.002 &&
          Math.abs(cp.lng - target.lng) < 0.002 &&
          Math.abs(cp.altitude) >= 0.01,
      );
      // Wait for teleport flight + post-teleport pitch lock ceiling (1200 + 800 ms) or animation end past flight
      const lockCleared = elapsed >= 2_100 || (Boolean(st?.animEnded) && elapsed >= 1_250);
      return nearModel && nearEye && lockCleared;
    },
    { lat: preset.lat, lng: preset.lng },
    { timeout: 18_000 },
  );

  // Wait briefly for post-teleport gmp-steadychange if not yet seen, then clean up listeners.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = document.querySelector('gmp-map-3d') as
          | (google.maps.maps3d.Map3DElement & { isSteady?: boolean })
          | null;
        const win = window as unknown as {
          __teleportState?: { steadySeen: boolean; cleanup: () => void };
        };
        const finish = () => {
          win.__teleportState?.cleanup();
          resolve();
        };
        if (!map || map.isSteady === true || win.__teleportState?.steadySeen) {
          finish();
          return;
        }
        const timer = window.setTimeout(() => {
          map.removeEventListener('gmp-steadychange', onSteady);
          finish();
        }, 4_000);
        const onSteady = (e: Event) => {
          if ((e as Event & { isSteady?: boolean }).isSteady) {
            window.clearTimeout(timer);
            map.removeEventListener('gmp-steadychange', onSteady);
            finish();
          }
        };
        map.addEventListener('gmp-steadychange', onSteady);
      }),
  );

  // Allow a couple of settled rAF frames so stationary terrain anchor refreshes cleanly.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
