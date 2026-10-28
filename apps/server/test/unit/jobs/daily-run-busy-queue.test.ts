// The randomised simulation of the daily runs (Milestone 2 D.2, risk table I; daily-run-simulation.ts) with a busy
// queue: jobs that take up to 3 minutes, some that start up to 70 minutes late, ticks retried seconds or minutes
// later, and outages of more than a day, so a job of a key `<prefix>:<org>:all` (E.2) can have two dates to catch up
// while its earlier run still waits or works. In its own file so the test runner runs it next to the planner tests.
import { describe, expect, it } from 'vitest';
import { simulate, type SimulationOptions } from './daily-run-simulation';

/** Lets the test runner's messages through between batches of runs. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

async function run(seeds: readonly number[], options: SimulationOptions) {
  const totals = { runs: 0, ticks: 0, jobs: 0, retriedTicks: 0, lateStarts: 0, longOutages: 0, dropped: 0, doubles: 0, misses: 0, mismatches: 0 };
  const failures: string[] = [];
  const lost: { misses: string[]; mismatches: string[] }[] = [];
  for (const seed of seeds) {
    if (seed % 100 === 0) await breathe();
    const result = simulate(seed, options);
    totals.runs++;
    totals.ticks += result.ticks;
    totals.jobs += result.runs;
    totals.retriedTicks += result.retriedTicks;
    totals.lateStarts += result.lateStarts;
    totals.longOutages += result.longOutage ? 1 : 0;
    totals.dropped += result.dropped;
    totals.doubles += result.doubles.length;
    totals.misses += result.misses.length;
    totals.mismatches += result.mismatches.length;
    if (result.misses.length + result.mismatches.length > 0) lost.push({ misses: result.misses, mismatches: result.mismatches });
    if (result.doubles.length + result.misses.length + result.mismatches.length > 0 && failures.length < 5) {
      failures.push(JSON.stringify({ seed, zoneChanges: result.zoneChanges, clockSetBack: result.clockSetBack, doubles: result.doubles, misses: result.misses, mismatches: result.mismatches }));
    }
  }
  return { totals, failures, lost };
}

describe('daily runs: randomised simulation with a busy queue (Milestone 2 D.2)', () => {
  const SEEDS = Array.from({ length: 5000 }, (_, i) => 1000 + i);

  it('works on each (job, local date) once and misses none with pg-boss, which reports a dropped send to the tick, over 5,000 runs', async () => {
    const { totals, failures } = await run(SEEDS, { queue: 'busy', driver: 'pgboss' });
    console.log(`daily run simulation, busy queue, pg-boss: ${JSON.stringify(totals)}`);
    expect(failures).toEqual([]);
    expect(totals).toMatchObject({ runs: 5000, doubles: 0, misses: 0, mismatches: 0 });
    // The simulation reaches the case: sends of an `all` key that a queued run of the job dropped, which the tick
    // deleted from the ledger and a later tick sent.
    expect(totals.dropped).toBeGreaterThan(0);
    expect(totals.retriedTicks).toBeGreaterThan(0);
    expect(totals.longOutages).toBeGreaterThan(0);
  }, 300_000);

  it('runs nothing twice with the BullMQ outbox, and loses only sends that a job of the same `all` key still queued after 30 minutes drops', async () => {
    // The outbox driver drops a send at relay time, after the tick, so the tick keeps the row. The planner's rule of
    // `RECENT_RUN_SECONDS` keeps the sends of one job apart; only a job that is still queued later than that can
    // drop the next date's run of its key.
    const { totals, lost } = await run(SEEDS.slice(0, 2000), { queue: 'busy', driver: 'outbox' });
    console.log(`daily run simulation, busy queue, BullMQ outbox: ${JSON.stringify(totals)}`);
    expect(totals.doubles).toBe(0);
    expect(totals.misses).toBeLessThanOrEqual(totals.dropped);
    for (const { misses, mismatches } of lost) {
      expect(mismatches.every((m) => /: the send was dropped by a queued job with the key (rr|de|cd):[^:]+:all$/.test(m))).toBe(true);
      const dropped = mismatches.map((m) => m.slice(0, m.indexOf(':')));
      expect(misses.filter((m) => !dropped.includes(m))).toEqual([]);
    }
  }, 300_000);
});
