import { defineConfig } from '@playwright/test';
import { apiLanesFor } from '../../tools/scripts/e2e-budget.mjs';

// API project (build plan J.6): the specs of e2e/ against a seeded api instead of the sample data. The stack runs
// several lanes (M2-21), each with its own database, api, storage gateway, mock providers and Mailpit, and each
// Playwright worker uses the lane of its parallelIndex (e2e-api/fixtures.js), so the tests run fully parallel while
// every test still resets its lane's database first. The number of lanes fits the memory budget
// (tools/scripts/e2e-budget.mjs: at most 6, and what E2E_MEMORY_BUDGET_MB leaves above the memory in use when the run
// starts); E2E_API_LANES sets it. There is one worker per lane, never more. Tests tagged @sample-only assert behaviour
// the api deliberately changes and are skipped here; @api-only specs (e2e/api-only) run only here.
// `node e2e-api/stack.mjs` builds and starts the stack and stops it, removing its containers, when Playwright sends
// SIGTERM.
process.env.E2E_API_LANES ||= String(apiLanesFor());
const LANES = Number(process.env.E2E_API_LANES);

// In CI each shard writes a blob report (E2E_REPORT=blob); the final job merges them into one HTML report. Every run
// ends with the peak memory in use on the machine (tools/scripts/e2e-memory-reporter.mjs; the stack logs its own too).
const memory = ['../../tools/scripts/e2e-memory-reporter.mjs', { label: `API suite (${LANES} lane(s))` }];
const reporter =
  process.env.E2E_REPORT === 'blob'
    ? [['list'], ['blob', { outputDir: 'blob-report/api' }], memory]
    : [['list'], ['html', { open: 'never', outputFolder: 'e2e-report/api' }], memory];

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: LANES,
  fullyParallel: true,
  grepInvert: /@sample-only/,
  outputDir: 'test-results/api',
  reporter,
  use: {
    // Lane 0; each test uses the web address of its worker's lane (the baseURL fixture of e2e/helpers.js).
    baseURL: 'http://localhost:4174',
    dataSource: 'api',
    actionTimeout: 15_000,
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
  webServer: {
    command: 'node e2e-api/stack.mjs',
    url: 'http://localhost:4174/api/v1/system/profile',
    reuseExistingServer: false,
    timeout: 900_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 60_000 },
  },
});
