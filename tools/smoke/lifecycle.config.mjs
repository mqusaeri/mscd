// Playwright configuration of the data lifecycle run (MILESTONE-3 M3-11). run-saas.mjs --lifecycle starts the SaaS test
// stack with the lifecycle periods at 0 days and passes the state of the run (SAAS_RUN_STATE): the app is served by
// Caddy over HTTPS with its own local certificate authority, so the browser accepts that certificate.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = process.env.SAAS_RUN_STATE ? JSON.parse(readFileSync(process.env.SAAS_RUN_STATE, 'utf8')) : null;
const outputDir = path.resolve(process.env.SAAS_OUTPUT_DIR || path.join(HERE, 'test-results', 'lifecycle'));

export default defineConfig({
  testDir: './tests',
  testMatch: 'data-lifecycle.spec.mjs',
  outputDir: path.join(outputDir, 'artifacts'),
  // One run in order against one stack: no parallel workers and no retries (a retry would meet the records the first
  // attempt already changed, and the purge cannot be undone).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(outputDir, 'report') }]],
  use: {
    baseURL: state?.baseUrl ?? 'https://localhost:18443',
    // Caddy's local certificate authority (tls internal) of the test stack; production uses Let's Encrypt.
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    // The people of the run work in Indonesia: Alpha's time zone and the installation's default. The screens count days
    // in the organisation's local date (D-07) and build instants in the browser's time zone, so the two agree.
    timezoneId: 'Asia/Jakarta',
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
