// The daily runs of `scheduler.tick` (Milestone 2 D.2, risk table I): the pure planner of the run ledger
// (`planDailyRuns`) and a randomised simulation of ticks, time zone changes and job starts around it (jobs that are
// done at their start; the simulation with a busy queue is in daily-run-busy-queue.test.ts). The database side (ledger
// rows, payload dates, dropped sends, If-Match, locks) is tested in test/int/onboarding/organization.test.ts.
import { describe, expect, it } from 'vitest';
import { addDays, instantOfLocal } from '../../../src/common/dates';
import { RECENT_RUN_SECONDS, planDailyRuns, type DailyPlanInput, type LedgerRun, type PlannedRun } from '../../../src/modules/jobs/daily-run-planner';
import { DAILY_JOBS, weekdayOfDate, type DailyJob } from '../../../src/modules/jobs/schedules';
import { simulate } from './daily-run-simulation';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const LONG_AGO = new Date('2029-01-01T00:00:00Z');

/** Ledger rows of every daily job on each of `dates`, at their local time in `zone` (enqueued at that instant). */
function fullDays(zone: string, ...dates: string[]): LedgerRun[] {
  return dates.flatMap((date) =>
    DAILY_JOBS.filter((j) => j.weekday === undefined || weekdayOfDate(date) === j.weekday).map((j) => {
      const scheduledFor = instantOfLocal(date, j.at, zone);
      return { job: j.name, localDate: date, scheduledFor, enqueuedAt: scheduledFor };
    }),
  );
}

/** One ledger row; enqueued at its due instant unless `enqueuedAt` is given. */
const row = (job: string, localDate: string, scheduledFor: string, enqueuedAt = scheduledFor): LedgerRun => ({
  job,
  localDate,
  scheduledFor: new Date(scheduledFor),
  enqueuedAt: new Date(enqueuedAt),
});

/** The ledger rows of planned runs, enqueued by a tick at `at`. */
const rowsOf = (runs: readonly PlannedRun[], at: string): LedgerRun[] =>
  runs.map((r) => ({ job: r.job.name, localDate: r.localDate, scheduledFor: r.scheduledFor, enqueuedAt: new Date(at) }));

/** The tick's plan, with the earliest local date and `enqueued_at` of `ledger` as the tick reads them. */
function plan(now: string, zone: string, ledger: LedgerRun[], extra: Partial<DailyPlanInput> = {}) {
  const firstLocalDate = ledger.length > 0 ? ledger.map((r) => r.localDate).sort()[0]! : null;
  const firstEnqueuedAt = ledger.length > 0 ? new Date(Math.min(...ledger.map((r) => r.enqueuedAt.getTime()))) : null;
  return planDailyRuns({ orgId: ORG, now: new Date(now), timeZone: zone, createdAt: LONG_AGO, ledger, firstLocalDate, firstEnqueuedAt, ...extra });
}
const summary = (runs: ReturnType<typeof plan>) => runs.map((r) => `${r.job.name}@${r.localDate} ${r.path} ${r.startAfterSeconds}`);
const names = (filter: (j: DailyJob) => boolean) => DAILY_JOBS.filter((j) => j.weekday === undefined && filter(j)).map((j) => j.name);

describe('planDailyRuns: the runs of one tick (Milestone 2 D.2)', () => {
  it('runs the jobs of the local hour, delayed to their minute, with the date and key of E.2 (the Milestone 1 behaviour)', () => {
    // 17:05 UTC is 00:05 on 16 January in Jakarta; the ledger holds 15 January.
    const runs = plan('2030-01-15T17:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15'));
    expect(summary(runs)).toEqual([
      'license.check@2030-01-16 due 0',
      'tasks.overdue@2030-01-16 due 600',
      'audit-prep.generate@2030-01-16 due 1500',
    ]);
    expect(runs.map((r) => r.singletonKey)).toEqual([`lc:${ORG}:2030-01-16`, `to:${ORG}:2030-01-16`, `ap:${ORG}:2030-01-16`]);
    expect(runs[1]!.scheduledFor.toISOString()).toBe('2030-01-15T17:15:00.000Z');
    // A run already in the ledger is not planned again (a second tick in the hour, a retried tick).
    const ledger = [...fullDays('Asia/Jakarta', '2030-01-15'), ...rowsOf(runs, '2030-01-15T17:05:00Z')];
    expect(plan('2030-01-15T17:40:00Z', 'Asia/Jakarta', ledger)).toEqual([]);
  });

  it('catches up the runs of today whose local time passed without a run, at once, and runs the hour as usual', () => {
    // 00:05 UTC on 16 January is 07:05 in Jakarta; nothing of 16 January ran (a worker that was down).
    const runs = plan('2030-01-16T00:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15'));
    expect(runs.filter((r) => r.path === 'catch-up').map((r) => r.job.name)).toEqual(names((j) => j.at < '07:00'));
    expect(runs.every((r) => r.localDate === '2030-01-16' && r.startAfterSeconds === 0)).toBe(true);
    expect(summary(runs.filter((r) => r.path === 'due'))).toEqual(['notifications.digest@2030-01-16 due 0']);
    // The catch-up keeps the run's own instant.
    expect(runs.find((r) => r.job.name === 'freshness.sweep')!.scheduledFor.toISOString()).toBe('2030-01-15T18:00:00.000Z');
  });

  it('catches up the previous local date first, and the current date at the next tick', () => {
    // 00:05 on 17 January in Jakarta; of 16 January only license.check ran.
    const ledger = [...fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15'), row('license.check', '2030-01-16', '2030-01-15T17:05:00Z')];
    const runs = plan('2030-01-16T17:05:00Z', 'Asia/Jakarta', ledger);
    expect(runs.filter((r) => r.localDate === '2030-01-16').map((r) => r.job.name)).toEqual(names((j) => j.name !== 'license.check'));
    expect(runs.filter((r) => r.localDate === '2030-01-16').every((r) => r.path === 'catch-up')).toBe(true);
    // license.check of 17 January is due in this hour; tasks.overdue and audit-prep.generate wait for their run of
    // 16 January: at most one run per job and tick, the earliest date first.
    expect(summary(runs.filter((r) => r.localDate === '2030-01-17'))).toEqual(['license.check@2030-01-17 due 0']);
    const after = [...ledger, ...rowsOf(runs, '2030-01-16T17:05:00Z')];
    expect(summary(plan('2030-01-16T18:05:00Z', 'Asia/Jakarta', after))).toEqual([
      'tasks.overdue@2030-01-17 catch-up 0',
      'audit-prep.generate@2030-01-17 catch-up 0',
      'freshness.sweep@2030-01-17 due 0',
    ]);
  });

  it('enqueues no second run of a job while its run of another date waits for its minute', () => {
    // drift.evaluate of 16 January waits for 02:45 in Jakarta (key `de:<org>:all`), and its run of 15 January is
    // missing. A second tick at 02:20 leaves that run to a later tick: sent now, the waiting job's key would drop it.
    const ledger = [
      ...fullDays('Asia/Jakarta', '2030-01-14'),
      ...fullDays('Asia/Jakarta', '2030-01-15').filter((r) => r.job !== 'drift.evaluate'),
      ...fullDays('Asia/Jakarta', '2030-01-16').filter((r) => r.scheduledFor < new Date('2030-01-15T19:00:00Z')),
      row('drift.evaluate', '2030-01-16', '2030-01-15T19:45:00Z', '2030-01-15T19:05:00Z'),
    ];
    const early = plan('2030-01-15T19:20:00Z', 'Asia/Jakarta', ledger);
    expect(early.map((r) => r.job.name)).not.toContain('drift.evaluate');
    expect(early.map((r) => r.job.name)).toContain('readiness.recompute');
    // After its start, the other date follows.
    expect(summary(plan('2030-01-15T19:50:00Z', 'Asia/Jakarta', ledger)).filter((s) => s.startsWith('drift'))).toEqual(['drift.evaluate@2030-01-15 catch-up 0']);
  });

  it('enqueues no second run of a job for 30 minutes after a catch-up run, which starts at once, and then the next date', () => {
    // A worker that was down from 14 January: at 03:05 on 16 January in Jakarta every job catches up 15 January.
    // readiness.recompute, drift.evaluate and cycle.derive have the keys `<prefix>:<org>:all` (E.2).
    const ledger = fullDays('Asia/Jakarta', '2030-01-13', '2030-01-14');
    const first = plan('2030-01-15T20:05:00Z', 'Asia/Jakarta', ledger);
    expect(first.map((r) => `${r.job.name}@${r.localDate} ${r.path}`)).toEqual(names(() => true).map((n) => `${n}@2030-01-15 catch-up`));
    const all = first.filter((r) => r.job.allSystems).map((r) => r.singletonKey);
    expect(all).toEqual([`rr:${ORG}:all`, `de:${ORG}:all`, `cd:${ORG}:all`]);
    // A retried tick 20 seconds later, and one 25 minutes later with the clock set back an hour: those jobs may still
    // wait or work, so their runs of 16 January wait. Sent now, the queue would drop them for the `all` keys.
    const after = [...ledger, ...rowsOf(first, '2030-01-15T20:05:00Z')];
    expect(plan('2030-01-15T20:05:20Z', 'Asia/Jakarta', after)).toEqual([]);
    expect(plan('2030-01-15T19:30:00Z', 'Asia/Jakarta', after)).toEqual([]);
    expect(RECENT_RUN_SECONDS).toBe(1800);
    // 35 minutes later, 16 January follows: its runs up to 03:40 at once.
    const next = plan('2030-01-15T20:40:00Z', 'Asia/Jakarta', after);
    expect(summary(next)).toEqual([
      ...names((j) => j.at < '03:00').map((n) => `${n}@2030-01-16 catch-up 0`),
      'cycle.derive@2030-01-16 due 0',
    ]);
    expect(next.filter((r) => r.job.allSystems).map((r) => r.singletonKey)).toEqual(all);
  });

  it('does not catch up runs before the organisation existed or before the first row of its ledger', () => {
    // A new organisation created at 10:00 in Jakarta: nothing of that morning, nothing of the day before.
    expect(plan('2030-01-16T04:05:00Z', 'Asia/Jakarta', [], { createdAt: new Date('2030-01-16T03:00:00Z') })).toEqual([]);
    expect(plan('2030-01-16T04:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-14'), { createdAt: new Date('2030-01-16T03:00:00Z') })).toEqual([]);
    // An organisation created at 01:30: the runs of that morning after its creation are caught up.
    const created = plan('2030-01-16T04:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15'), { createdAt: new Date('2030-01-15T18:30:00Z') });
    expect(created.map((r) => r.job.name)).toEqual(names((j) => j.at > '01:30' && j.at < '11:00'));
    // A fresh ledger (an upgrade, a new installation): nothing is caught up before its first row.
    expect(summary(plan('2030-01-16T04:05:00Z', 'Asia/Jakarta', []))).toEqual([]);
    // Its only row is license.check at 00:05 on 17 January. At 02:05 the missing runs due after that row are caught up,
    // on the ledger's first day too, and none of 16 January, which were due before it.
    const firstRun = row('license.check', '2030-01-17', '2030-01-16T17:05:00Z');
    expect(summary(plan('2030-01-16T19:05:00Z', 'Asia/Jakarta', [firstRun]))).toEqual([
      'tasks.overdue@2030-01-17 catch-up 0',
      'audit-prep.generate@2030-01-17 catch-up 0',
      'freshness.sweep@2030-01-17 catch-up 0',
      'link-health.plan@2030-01-17 due 0',
      'link-health.repository@2030-01-17 due 1500',
      'readiness.recompute@2030-01-17 due 1500',
      'drift.evaluate@2030-01-17 due 2400',
    ]);
    // A ledger that starts at 00:20 does not catch up the runs of 00:05 and 00:15 that day; the next date runs in full.
    const lateStart = row('audit-prep.generate', '2030-01-17', '2030-01-16T17:30:00Z', '2030-01-16T17:20:00Z');
    expect(plan('2030-01-16T19:05:00Z', 'Asia/Jakarta', [lateStart]).filter((r) => r.path === 'catch-up').map((r) => r.job.name)).toEqual(['freshness.sweep']);
    const second = plan('2030-01-17T19:05:00Z', 'Asia/Jakarta', [lateStart]);
    expect(second.filter((r) => r.path === 'catch-up').map((r) => `${r.job.name}@${r.localDate}`)).toContain('license.check@2030-01-18');
    expect(second.filter((r) => r.localDate === '2030-01-17').map((r) => r.job.name)).toEqual(names((j) => j.at > '00:20' && j.name !== 'audit-prep.generate'));
  });

  it('catches up, on the first day of the ledger, a run whose send the queue dropped and a run skipped while its job waited', () => {
    // UTC, a fresh ledger from 00:05 on 16 January. At 02:05 a job queued for every system holds `rr:<org>:all`, so
    // the queue drops readiness.recompute and the tick deletes its row (scheduler-tick.job.ts). At 03:05 it follows.
    let ledger = fullDays('UTC', '2030-01-16').filter((r) => r.scheduledFor < new Date('2030-01-16T02:00:00Z'));
    const at0205 = plan('2030-01-16T02:05:00Z', 'UTC', ledger);
    expect(at0205.map((r) => r.job.name)).toContain('readiness.recompute');
    ledger = [...ledger, ...rowsOf(at0205.filter((r) => r.job.name !== 'readiness.recompute'), '2030-01-16T02:05:00Z')];
    expect(summary(plan('2030-01-16T03:05:00Z', 'UTC', ledger))).toEqual(['readiness.recompute@2030-01-16 catch-up 0', 'cycle.derive@2030-01-16 due 600']);
    // Kiritimati (UTC+14), a fresh ledger from 00:05 on 16 January there (10:05 UTC on 15 January); the tick of 03:05
    // (13:05 UTC) sent cycle.derive of 16 January for 03:15. At 13:10 UTC the organisation moves 24 hours west, to
    // Honolulu: 03:10 on 15 January. A tick at 13:20 UTC finds cycle.derive of 15 January due, but its run of 16 January
    // may still wait, so it sends nothing of that job; at 14:05 the run is caught up, as its instant (13:15 UTC) comes
    // after the ledger's first row.
    const kiritimati = fullDays('Pacific/Kiritimati', '2030-01-16')
      .filter((r) => r.scheduledFor <= new Date('2030-01-15T13:15:00Z'))
      .map((r) => (r.job === 'cycle.derive' ? { ...r, enqueuedAt: new Date('2030-01-15T13:05:00Z') } : r));
    const at1320 = plan('2030-01-15T13:20:00Z', 'Pacific/Honolulu', kiritimati);
    expect(at1320.map((r) => r.job.name)).not.toContain('cycle.derive');
    const after1320 = [...kiritimati, ...rowsOf(at1320, '2030-01-15T13:20:00Z')];
    const at1405 = plan('2030-01-15T14:05:00Z', 'Pacific/Honolulu', after1320);
    expect(summary(at1405.filter((r) => r.job.name === 'cycle.derive'))).toEqual(['cycle.derive@2030-01-15 catch-up 0']);
    expect(at1405.find((r) => r.job.name === 'cycle.derive')!.scheduledFor.toISOString()).toBe('2030-01-15T13:15:00.000Z');
  });

  it('runs the weekly job on its weekday only, and catches it up on the day after', () => {
    // Sunday 20 January 2030, 03:05 in Jakarta: integrity.rehash and cycle.derive are due.
    const sunday = plan('2030-01-19T20:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-18', '2030-01-19', '2030-01-20').filter((r) => r.scheduledFor < new Date('2030-01-19T20:00:00Z')));
    expect(summary(sunday)).toEqual(['integrity.rehash@2030-01-20 due 0', 'cycle.derive@2030-01-20 due 600']);
    // Monday 00:05: the Sunday run did not happen (no tick at 03:05), so it is caught up; Monday has none.
    const missed = fullDays('Asia/Jakarta', '2030-01-18', '2030-01-19', '2030-01-20').filter((r) => r.job !== 'integrity.rehash' || r.localDate !== '2030-01-20');
    const monday = plan('2030-01-20T17:05:00Z', 'Asia/Jakarta', missed);
    expect(summary(monday.filter((r) => r.job.name === 'integrity.rehash'))).toEqual(['integrity.rehash@2030-01-20 catch-up 0']);
    expect(plan('2030-01-21T20:05:00Z', 'Asia/Jakarta', fullDays('Asia/Jakarta', '2030-01-19', '2030-01-20', '2030-01-21')).map((r) => r.job.name)).not.toContain('integrity.rehash');
  });

  it('plans zones with 30 and 45 minute offsets by their local hour, and catches up an hour that a late tick skipped', () => {
    // 19:05 UTC is 00:35 in Kolkata (UTC+5:30): the three jobs of 00:xx, two of them past their minute.
    expect(summary(plan('2030-01-15T19:05:00Z', 'Asia/Kolkata', fullDays('Asia/Kolkata', '2030-01-14', '2030-01-15')))).toEqual([
      'license.check@2030-01-16 due 0',
      'tasks.overdue@2030-01-16 due 0',
      'audit-prep.generate@2030-01-16 due 0',
    ]);
    // Kathmandu (UTC+5:45): the tick of 20:05 UTC comes 40 minutes late, at 02:30 local. The 01:00 sweep, which the
    // tick of 01:50 would have run, is caught up; the jobs of 02:xx are due.
    const ledger = [...fullDays('Asia/Kathmandu', '2030-01-14', '2030-01-15'), ...fullDays('Asia/Kathmandu', '2030-01-16').filter((r) => r.scheduledFor < new Date('2030-01-15T19:00:00Z'))];
    expect(summary(plan('2030-01-15T20:45:00Z', 'Asia/Kathmandu', ledger))).toEqual([
      'freshness.sweep@2030-01-16 catch-up 0',
      'link-health.plan@2030-01-16 due 0',
      'link-health.repository@2030-01-16 due 0',
      'readiness.recompute@2030-01-16 due 0',
      'drift.evaluate@2030-01-16 due 900',
    ]);
  });

  it('runs each date once after a move west and catches up the skipped date after a move east', () => {
    // Jakarta ran 16 January up to 07:00. A move to New York at 09:00 Jakarta time (21:00 on 15 January there) runs
    // nothing again: 16 January in New York finds its rows.
    const ran = fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15', '2030-01-16');
    for (let h = 2; h <= 26; h++) {
      const now = new Date(Date.parse('2030-01-16T02:05:00Z') + h * 3_600_000).toISOString();
      expect(plan(now, 'America/New_York', ran), now).toEqual([]);
    }
    // New York ran 15 January. A move to Tokyo at 23:30 New York time (13:30 on 16 January in Tokyo, 14 hours east):
    // the next tick catches up 16 January once.
    const ny = fullDays('America/New_York', '2030-01-13', '2030-01-14', '2030-01-15');
    const caught = plan('2030-01-16T05:05:00Z', 'Asia/Tokyo', ny);
    expect(caught.map((r) => r.job.name)).toEqual(names(() => true));
    expect(caught.every((r) => r.localDate === '2030-01-16' && r.path === 'catch-up')).toBe(true);
    // A move of 17 hours east late in the day (Honolulu 23:30 on 15 January to Jayapura 18:30 on 16 January).
    const honolulu = fullDays('Pacific/Honolulu', '2030-01-13', '2030-01-14', '2030-01-15');
    const far = plan('2030-01-16T10:05:00Z', 'Asia/Jayapura', honolulu);
    expect(far.map((r) => `${r.job.name}@${r.localDate}`)).toEqual(names(() => true).map((n) => `${n}@2030-01-16`));
  });

  it('runs the daily jobs of a day that daylight saving shortens or lengthens once', () => {
    // Sunday 10 March 2030 in New York: 02:00 to 02:59 do not exist. The tick of 03:05 catches up the jobs of 02:xx
    // and runs those of 03:xx (the weekly rehash of Sunday among them).
    const before = [...fullDays('America/New_York', '2030-03-08', '2030-03-09'), ...fullDays('America/New_York', '2030-03-10').filter((r) => DAILY_JOBS.find((j) => j.name === r.job)!.at < '02:00')];
    const runs = plan('2030-03-10T07:05:00Z', 'America/New_York', before);
    expect(summary(runs)).toEqual([
      'link-health.plan@2030-03-10 catch-up 0',
      'link-health.repository@2030-03-10 catch-up 0',
      'readiness.recompute@2030-03-10 catch-up 0',
      'drift.evaluate@2030-03-10 catch-up 0',
      'integrity.rehash@2030-03-10 due 0',
      'cycle.derive@2030-03-10 due 600',
    ]);
    // 3 November 2030: 01:00 to 01:59 come twice. The second 01:05 runs nothing.
    const fallBack = [...fullDays('America/New_York', '2030-11-01', '2030-11-02'), ...fullDays('America/New_York', '2030-11-03').filter((r) => r.job === 'freshness.sweep' || r.scheduledFor < new Date('2030-11-03T05:00:00Z'))];
    expect(plan('2030-11-03T06:05:00Z', 'America/New_York', fallBack)).toEqual([]);
  });

  it('leaves the runs of a clock set back an hour to their ledger rows', () => {
    const ledger = [...fullDays('Asia/Jakarta', '2030-01-14', '2030-01-15'), ...fullDays('Asia/Jakarta', '2030-01-16').filter((r) => r.scheduledFor <= new Date('2030-01-15T19:45:00Z'))];
    // The tick of 03:05 reads 02:05 after the clock went back: the jobs of 02:xx are in the ledger.
    expect(plan('2030-01-15T19:05:00Z', 'Asia/Jakarta', ledger)).toEqual([]);
    expect(addDays('2030-01-16', -1)).toBe('2030-01-15');
  });
});

describe('daily runs: randomised simulation of ticks, time zone changes and job starts (Milestone 2 D.2)', () => {
  const SEEDS = Array.from({ length: 5000 }, (_, i) => 1000 + i);

  /** Lets the test runner's messages through between batches of runs. */
  const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('works on each (job, local date) once, on the date of its ledger row, and misses none, over 5,000 runs', async () => {
    const totals = { runs: 0, ticks: 0, jobs: 0, zoneChanges: 0, clockSetBack: 0, startDateDiffers: 0, doubles: 0, misses: 0, mismatches: 0 };
    const failures: string[] = [];
    for (const seed of SEEDS) {
      if (seed % 100 === 0) await breathe();
      const result = simulate(seed);
      totals.runs++;
      totals.ticks += result.ticks;
      totals.jobs += result.runs;
      totals.zoneChanges += result.zoneChanges.length;
      totals.clockSetBack += result.clockSetBack ? 1 : 0;
      totals.startDateDiffers += result.startDateDiffers;
      totals.doubles += result.doubles.length;
      totals.misses += result.misses.length;
      totals.mismatches += result.mismatches.length;
      if (result.doubles.length + result.misses.length + result.mismatches.length > 0 && failures.length < 5) {
        failures.push(JSON.stringify({ seed, zoneChanges: result.zoneChanges, clockSetBack: result.clockSetBack, doubles: result.doubles, misses: result.misses, mismatches: result.mismatches }));
      }
    }
    console.log(`daily run simulation: ${JSON.stringify(totals)}`);
    expect(failures).toEqual([]);
    expect(totals).toMatchObject({ runs: 5000, doubles: 0, misses: 0, mismatches: 0 });
    // The simulation reaches the cases the ledger is for: jobs that start on another local date than their run's.
    expect(totals.startDateDiffers).toBeGreaterThan(0);
  }, 300_000);

  it('finds doubles and misses when jobs work on the date at their start (the design the payload date replaces)', async () => {
    let doubles = 0;
    let misses = 0;
    for (const seed of SEEDS.slice(0, 1000)) {
      if (seed % 100 === 0) await breathe();
      const result = simulate(seed, { workOn: 'date-at-start' });
      doubles += result.doubles.length;
      misses += result.misses.length;
    }
    console.log(`daily run simulation, date at start: ${JSON.stringify({ runs: 1000, doubles, misses })}`);
    expect(doubles).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);
  }, 300_000);
});
