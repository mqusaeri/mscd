// Playwright configuration of the SaaS end-to-end run (Milestone 2 plan K.6, M2-S13). run-saas.mjs starts the SaaS
// test stack and passes the state of the run (SAAS_RUN_STATE): the app is served by Caddy over HTTPS with its own
// local certificate authority, so the browser accepts that certificate.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = process.env.SAAS_RUN_STATE ? JSON.parse(readFileSync(process.env.SAAS_RUN_STATE, 'utf8')) : null;
const outputDir = path.resolve(process.env.SAAS_OUTPUT_DIR || path.join(HERE, 'test-results', 'saas'));

export default defineConfig({
  testDir: './tests',
  testMatch: 'saas.spec.mjs',
  outputDir: path.join(outputDir, 'artifacts'),
  // One run in order against one stack: no parallel workers and no retries (a retry would meet the records the first
  // attempt already changed).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(outputDir, 'report') }]],
  use: {
    baseURL: state?.baseUrl ?? 'https://localhost:18443',
    // Caddy's local certificate authority (tls internal) of the test stack; production uses Let's Encrypt.
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
