#!/usr/bin/env node
// Both browser suites in one command, inside the memory budget (Milestone 2 M2-21): `npm run test:e2e:all -w
// @mscd/web`. It reads the memory in use, chooses the API lanes and the sample workers that fit the budget
// (tools/scripts/e2e-budget.mjs), runs the sample suite next to the API suite when both fit and one after the other
// when they do not, samples the memory in use every 2 seconds, and prints the wall time, the test count and the peak
// memory in use of each suite. It exits 1 when a suite fails; a peak above the budget is reported in the summary.
//
// Usage: node tools/scripts/e2e-all.mjs [--sample-only | --api-only] [--sequential] [-- <playwright options>]
// Environment: E2E_MEMORY_BUDGET_MB (default 12288), E2E_API_LANES and E2E_SAMPLE_WORKERS (default: from the budget);
// the variables of e2e-api/stack.mjs (MSCD_TEST_CONTAINER_PREFIX, E2E_STACK_CACHE, ...) pass through.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  apiLanesFor, apiNeedMb, budgetMb, cpuCount, memInUseMb, memorySampler, peakLine, sampleNeedMb, sampleWorkersFor,
} from './e2e-budget.mjs';
import { CACHE_DIR, ROOT } from './e2e-cache.mjs';

const WEB = path.join(ROOT, 'apps/web');
/** Fewer sample workers than this next to the API suite is slower than running the suites one after the other. */
const MIN_SIDE_WORKERS = 4;

const { values, positionals } = parseArgs({
  options: { 'sample-only': { type: 'boolean' }, 'api-only': { type: 'boolean' }, sequential: { type: 'boolean' }, help: { type: 'boolean' } },
  allowPositionals: true,
  strict: true,
});
if (values.help) {
  process.stdout.write('Usage: node tools/scripts/e2e-all.mjs [--sample-only | --api-only] [--sequential] [-- <playwright options>]\n');
  process.exit(0);
}
const wantSample = !values['api-only'];
const wantApi = !values['sample-only'];

const say = (line) => process.stdout.write(`e2e-all: ${line}\n`);
const minutes = (ms) => `${(ms / 60000).toFixed(1)} min (${Math.round(ms / 1000)} s)`;

/** Runs one suite; resolves with its wall time, exit code and the counts from Playwright's output. */
function runSuite(name, args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...args, ...positionals], {
      cwd: WEB,
      env: { ...process.env, TZ: process.env.TZ || 'UTC', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = { name, tests: null, workers: null, passed: 0, failed: 0, flaky: 0, skipped: 0, didNotRun: 0 };
    const scan = (line) => {
      // eslint-disable-next-line no-control-regex
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      const running = /Running (\d+) tests? using (\d+) workers?/.exec(plain);
      if (running) {
        result.tests = Number(running[1]);
        result.workers = Number(running[2]);
      }
      const count = /^\s+(\d+) (passed|failed|flaky|skipped|did not run)\b/.exec(plain);
      if (count) result[{ passed: 'passed', failed: 'failed', flaky: 'flaky', skipped: 'skipped', 'did not run': 'didNotRun' }[count[2]]] = Number(count[1]);
    };
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          scan(line);
          target.write(`[${name}] ${line}\n`);
        }
      });
    }
    child.on('close', (code, signal) => resolve({ ...result, code: code ?? 1, signal, wallMs: Date.now() - started }));
  });
}

const budget = budgetMb();
const inUse = memInUseMb();
const cpus = cpuCount();
const lanes = Number(process.env.E2E_API_LANES) || apiLanesFor({ inUse, budget, cpus });
let concurrent = false;
let workers = Number(process.env.E2E_SAMPLE_WORKERS) || 0;
if (wantSample && wantApi && !values.sequential) {
  const side = sampleWorkersFor({ inUse, budget, cpus, reserveMb: apiNeedMb(lanes) });
  if (side >= MIN_SIDE_WORKERS && inUse + apiNeedMb(lanes) + sampleNeedMb(side) <= budget) {
    concurrent = true;
    workers ||= side;
  }
}
if (wantSample && !workers) workers = sampleWorkersFor({ inUse, budget, cpus });
say(`memory in use ${inUse} MB of a ${budget} MB budget, ${cpus} CPUs`);
say(
  [wantApi && `API suite: ${lanes} lane(s)`, wantSample && `sample suite: ${workers} worker(s)`, wantSample && wantApi && (concurrent ? 'side by side' : 'one after the other')]
    .filter(Boolean)
    .join(', '),
);

const all = memorySampler({ intervalMs: 2000 });
const results = [];
const sampleRun = () => runSuite('sample', ['-c', 'playwright.config.js'], { E2E_SAMPLE_WORKERS: String(workers) });
const apiRun = () => runSuite('api', ['-c', 'playwright.api.config.js'], { E2E_API_LANES: String(lanes) });
const started = Date.now();
if (concurrent) {
  const sampler = memorySampler({ intervalMs: 2000 });
  const done = await Promise.all([apiRun(), sampleRun()]);
  const { peakMb } = sampler.stop();
  for (const r of done) results.push({ ...r, peakMb, peakNote: 'both suites side by side' });
} else {
  for (const [want, start] of [[wantApi, apiRun], [wantSample, sampleRun]]) {
    if (!want) continue;
    const sampler = memorySampler({ intervalMs: 2000 });
    const r = await start();
    results.push({ ...r, peakMb: sampler.stop().peakMb });
    // A later suite chooses its workers from the memory in use once the first one has ended.
    if (start === apiRun && wantSample && !process.env.E2E_SAMPLE_WORKERS) workers = sampleWorkersFor({ budget, cpus });
  }
}
const overall = all.stop();

say('summary');
for (const r of results) {
  const counts = [`${r.passed} passed`, r.failed && `${r.failed} failed`, r.flaky && `${r.flaky} flaky`, r.skipped && `${r.skipped} skipped`, r.didNotRun && `${r.didNotRun} did not run`]
    .filter(Boolean)
    .join(', ');
  say(
    `${r.name} suite: ${r.code === 0 ? 'passed' : 'FAILED'} in ${minutes(r.wallMs)}, ${r.tests ?? '?'} tests on ${r.workers ?? '?'} worker(s) (${counts}), ` +
      `peak memory in use ${r.peakMb} MB${r.peakNote ? ` (${r.peakNote})` : ''}`,
  );
}
say(`total wall time ${minutes(Date.now() - started)}`);
say(peakLine('whole run', overall, budget));
mkdirSync(CACHE_DIR, { recursive: true });
writeFileSync(
  path.join(CACHE_DIR, 'last-e2e-all.json'),
  JSON.stringify({ at: new Date().toISOString(), budget, startMb: overall.startMb, peakMb: overall.peakMb, concurrent, lanes, workers, results }, null, 2),
);
if (overall.peakMb > budget) say(`the peak memory in use (${overall.peakMb} MB) went over the budget of ${budget} MB`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
