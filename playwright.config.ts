import { defineConfig } from '@playwright/test';
import { getWebGlArgs, loadEnvIfNeeded, resolveChromeChannel } from './e2e/helpers.ts';

loadEnvIfNeeded();

const isCI = Boolean(process.env.CI);
const ciRetries = Number(process.env.PLAYWRIGHT_RETRIES ?? '0');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  retries: isCI && Number.isFinite(ciRetries) ? ciRetries : 0,
  workers: 1,
  use: {
    channel: resolveChromeChannel(),
    headless: true,
    viewport: { width: 640, height: 480 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: getWebGlArgs(true),
    },
  },
});
