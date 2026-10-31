// Playwright reporter of both browser suites (Milestone 2 M2-21): samples the memory in use on the machine
// (MemTotal - MemAvailable) every 2 seconds from the start of the run (the reporter is created before the web server
// starts, so its build counts) and prints the peak against the budget at the end, so every run, not only
// `npm run test:e2e:all`, says whether it stayed inside E2E_MEMORY_BUDGET_MB (default 12288).
import { budgetMb, memorySampler, peakLine } from './e2e-budget.mjs';

export default class MemoryReporter {
  constructor(options = {}) {
    this.label = options.label ?? 'browser suite';
    this.sampler = memorySampler({ intervalMs: 2000 });
  }

  onEnd() {
    if (!this.sampler) return;
    process.stdout.write(`\n${peakLine(this.label, this.sampler.stop(), budgetMb())}\n`);
  }

  printsToStdio() {
    return true;
  }
}
