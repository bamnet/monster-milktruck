import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

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
  const metersPerDegLat = 111_319.9;
  const dN = (b.lat - a.lat) * metersPerDegLat;
  const midLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dE = (b.lng - a.lng) * metersPerDegLat * Math.cos(midLatRad);
  return Math.hypot(dE, dN);
}
