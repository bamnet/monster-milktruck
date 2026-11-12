import { defineConfig } from '@playwright/test';
import { getWebGlArgs, loadEnvIfNeeded, resolveChromeChannel } from './e2e/helpers.ts';

loadEnvIfNeeded();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 45_000,
  workers: 1,
  use: {
    channel: resolveChromeChannel(),
    headless: true,
    viewport: { width: 640, height: 480 },
    launchOptions: {
      args: getWebGlArgs(true),
    },
  },
});
