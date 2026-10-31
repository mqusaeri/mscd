// Memory budget of the browser suites (Milestone 2 M2-21). The machine must stay at or below the budget in use
// (MemTotal - MemAvailable, default 12288 MB, E2E_MEMORY_BUDGET_MB) whatever else runs on it, so each runner reads
// MemAvailable when it starts and chooses the number of API lanes or sample workers that fit. The per-lane and
// per-worker costs below were measured on the build host (resident memory of each process during a full run); they
// include the Chromium of the Playwright worker. `memorySampler` records the peak in use during a run.
import { readFileSync } from 'node:fs';
import os from 'node:os';

/** Default budget: 12 GB in use on the whole machine (product owner, 2026-10-31). */
export const DEFAULT_BUDGET_MB = 12288;

/**
 * Measured costs in MB. An API lane: its api, storage gateway, mock providers and Mailpit, one Playwright worker and
 * its Chromium. API fixed: PostgreSQL with the lane databases, SeaweedFS, the web server and the Playwright runner,
 * plus the builds of a cold start. A sample worker: one Playwright worker and its Chromium. Sample fixed: the runner,
 * `vite preview` and a build of the app.
 */
export const COSTS = { apiLane: 1100, apiFixed: 1500, sampleWorker: 600, sampleFixed: 1200 };
export const MAX_API_LANES = 6;
export const MAX_SAMPLE_WORKERS = 10;

/** Memory in use on the machine in MB: MemTotal - MemAvailable (Linux), else total - free. */
export function memInUseMb() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (Number.isFinite(total) && Number.isFinite(available)) return Math.round((total - available) / 1024);
  } catch {
    // not Linux
  }
  return Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
}

/** The budget in MB (E2E_MEMORY_BUDGET_MB, default 12288). */
export function budgetMb(env = process.env) {
  const value = Number(env.E2E_MEMORY_BUDGET_MB || DEFAULT_BUDGET_MB);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`E2E_MEMORY_BUDGET_MB must be a positive number of MB, got "${env.E2E_MEMORY_BUDGET_MB}"`);
  return value;
}

/** Logical CPUs. */
export function cpuCount() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Number of API lanes that fit: what the budget leaves above the memory in use now (minus `reserveMb`, for example a
 * sample suite that runs next to it), the fixed cost first, one lane per COSTS.apiLane, at most 6 and at most half the
 * CPUs. Never below 1: a machine that cannot hold one lane runs one anyway and the run reports the peak.
 */
export function apiLanesFor({ inUse = memInUseMb(), budget = budgetMb(), cpus = cpuCount(), reserveMb = 0, max = MAX_API_LANES } = {}) {
  const free = budget - inUse - reserveMb - COSTS.apiFixed;
  return clamp(Math.floor(free / COSTS.apiLane), 1, Math.min(max, Math.max(1, Math.floor(cpus / 2))));
}

/** Number of sample workers that fit, the same way (at most 10 and at most half the CPUs). */
export function sampleWorkersFor({ inUse = memInUseMb(), budget = budgetMb(), cpus = cpuCount(), reserveMb = 0, max = MAX_SAMPLE_WORKERS } = {}) {
  const free = budget - inUse - reserveMb - COSTS.sampleFixed;
  return clamp(Math.floor(free / COSTS.sampleWorker), 1, Math.min(max, Math.max(1, Math.floor(cpus / 2))));
}

/** Memory an API run with `lanes` lanes needs above what is in use now. */
export const apiNeedMb = (lanes) => COSTS.apiFixed + lanes * COSTS.apiLane;
/** Memory a sample run with `workers` workers needs above what is in use now. */
export const sampleNeedMb = (workers) => COSTS.sampleFixed + workers * COSTS.sampleWorker;

/**
 * Samples the memory in use every `intervalMs` until `stop()`; `stop()` returns { peakMb, startMb, samples }.
 * `onSample` sees each value (the runner writes them to a log).
 */
export function memorySampler({ intervalMs = 2000, onSample } = {}) {
  const startMb = memInUseMb();
  let peakMb = startMb;
  let samples = 1;
  const timer = setInterval(() => {
    const now = memInUseMb();
    samples += 1;
    if (now > peakMb) peakMb = now;
    onSample?.(now);
  }, intervalMs);
  timer.unref();
  return {
    get peakMb() {
      return peakMb;
    },
    stop() {
      clearInterval(timer);
      const now = memInUseMb();
      if (now > peakMb) peakMb = now;
      return { peakMb, startMb, samples };
    },
  };
}

/** One line for a log: the peak in use against the budget. */
export function peakLine(label, { peakMb, startMb }, budget = budgetMb()) {
  const verdict = peakMb <= budget ? 'within' : 'OVER';
  return `${label}: peak memory in use ${peakMb} MB (${verdict} the budget of ${budget} MB; ${startMb} MB at the start)`;
}
