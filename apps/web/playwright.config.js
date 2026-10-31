import { defineConfig } from '@playwright/test';
import { sampleWorkersFor } from '../../tools/scripts/e2e-budget.mjs';

// The number of workers fits the memory budget (M2-21, tools/scripts/e2e-budget.mjs: at most 10, and what
// E2E_MEMORY_BUDGET_MB leaves above the memory in use when the run starts). E2E_SAMPLE_WORKERS sets it, and so does
// `--workers`. Worker processes read the value the runner chose.
process.env.E2E_SAMPLE_WORKERS ||= String(sampleWorkersFor());

// In CI each shard writes a blob report (E2E_REPORT=blob); the final job merges them into one HTML report. Every run
// ends with the peak memory in use on the machine (tools/scripts/e2e-memory-reporter.mjs).
const memory = ['../../tools/scripts/e2e-memory-reporter.mjs', { label: 'sample suite' }];
const reporter =
  process.env.E2E_REPORT === 'blob'
    ? [['list'], ['blob', { outputDir: 'blob-report/sample' }], memory]
    : [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }], memory];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: Number(process.env.E2E_SAMPLE_WORKERS),
  // @api-only specs (e2e/api-only) need the api; the API project runs them (playwright.api.config.js, build plan J.6).
  grepInvert: /@api-only/,
  reporter,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    // Software compositing instead of an emulated GPU (M2-21): the same pictures (the app draws on 2D canvases only,
    // and CI runners have no GPU either) for about a tenth less browser CPU, which the parallel workers share.
    launchOptions: { args: ['--disable-gpu'] },
    // Traces stay on failure in GitHub Actions. Recording them tripled the time of a local run (M2-21: display.spec.js
    // on 10 workers took 237 s with traces and 81 s without), so a local run, also with CI=1, records them only on a
    // retry; E2E_TRACE=retain-on-failure (or `--trace retain-on-failure`) keeps them for a failure you look into.
    trace: process.env.E2E_TRACE || (process.env.GITHUB_ACTIONS ? 'retain-on-failure' : 'on-first-retry'),
  },
  // Every run serves a build of the current sources: tools/scripts/e2e-web-serve.mjs builds the app when its sources
  // changed since the last build (else it reuses that build, M2-21) and serves it. A server already listening on 4173
  // (for example a `npm run preview` left running) makes the run stop with an error instead of testing a stale build.
  webServer: {
    command: 'node ../../tools/scripts/e2e-web-serve.mjs sample 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
