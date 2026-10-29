// Playwright configuration of the fresh-organisation journey (MILESTONE-2 M2-18). run-journey.mjs starts the stack,
// runs the installer step and passes the ports and the state of the run through the environment.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { smokeSettings } from './lib/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settings = smokeSettings();
const outputDir = path.resolve(process.env.JOURNEY_OUTPUT_DIR || path.join(HERE, 'test-results', 'journey'));

export default defineConfig({
  testDir: './tests',
  testMatch: 'fresh-org.spec.mjs',
  outputDir: path.join(outputDir, 'artifacts'),
  // One journey in order against one stack: no parallel workers and no retries (a retry would meet the records the
  // first attempt already changed).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(outputDir, 'report') }]],
  use: {
    baseURL: settings.baseUrl,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Keycloak's issuer is http://keycloak:<port> for the browser and the containers alike (see run-smoke.mjs).
        launchOptions: { args: [`--host-resolver-rules=${settings.hostResolverRules}`] },
      },
    },
  ],
});
