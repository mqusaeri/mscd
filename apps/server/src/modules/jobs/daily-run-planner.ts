// The daily runs that one `scheduler.tick` enqueues for one organisation (Milestone 2 D.2, risk table I), as a pure
// function of the tick's clock, the organisation's current time zone and creation time, and its rows in the run
// ledger `platform.daily_job_run` (orchestrator decision between waves 2a and 2b, docs/platform/handoff/M2-06.md).
//
// A run is one organisation, one daily job of E.2 and one local date. The tick inserts the run's ledger row before it
// sends the job, in the same transaction, and the job works on the run's date (`localDate` of its payload). So each
// job runs at most once per local date by construction, whatever the time zone does, whether ticks come early, late,
// twice or not at all, and whether the clock is set back. The planner only decides which runs are due:
//
// - Due: a run of the current local date whose local time falls in the local hour of the tick, delayed to its local
//   minute (0 when that minute has passed). This is the Milestone 1 behaviour of the tick.
// - Catch-up: a run of the current or the previous local date whose local time has passed without a run (a tick that
//   did not come, a worker that was down, a time zone change east, a job that was still waiting (below) or a send the
//   queue dropped (scheduler-tick.job.ts)). It starts at once. Only when the organisation existed at the run's instant
//   and the ledger already kept the organisation's runs then: it holds a row of the organisation of an earlier local
//   date, or one enqueued at or before the run's instant. So a new organisation or a fresh ledger (an upgrade from
//   Milestone 1) gets no burst of past runs, and a run missed after the first row is caught up, on the first day too.
// - A weekly job runs only on its weekday.
// - Per job, a tick enqueues at most one run, the earliest date first, and none while an earlier run of that job may
//   still be in the queue: a run that is not due to start yet, or one enqueued less than `RECENT_RUN_SECONDS` before
//   the tick (a catch-up starts at once, so its due instant is already past while its job waits or works). Runs of one
//   job are therefore enqueued in date order, and a job that records a state (`license.check`) does not record an
//   older date after a newer one. Jobs keyed `<prefix>:<org>:all` (E.2) would otherwise lose the later run to the
//   singleton key of the earlier one (E.1: at most one waiting or active job per key). This rule covers a repeated
//   tick and a short queue delay; for a job that is still queued later than that, the tick removes the ledger row of
//   a send the queue drops, so a later tick plans the run again (scheduler-tick.job.ts).
//
// Limits. A run whose date leaves the window of the current and the previous local date before a tick enqueues it is
// not run. This takes an outage of more than a day, a move east of about 24 hours, or a send dropped at the edge of
// the window: (a) after an outage that leaves two dates of a job to catch up, the tick enqueues the earlier date, and
// a move east of about 24 hours (or another outage of a day) before the next tick moves the later date out of the
// window; (b) a run whose send the queue drops at the last tick before its date leaves the window is not planned
// again. On the first local date of the ledger, a run due before the organisation's first row is not caught up, which
// includes a run whose dropped send would have been that first row.
import { addDays, instantOfLocal } from '../../common/dates';
import { DAILY_JOBS, dailySingletonKey, localTimeOf, weekdayOfDate, type DailyJob } from './schedules';

/**
 * How long after a run is enqueued the planner assumes that its job may still be waiting or working: longer than a
 * retried or repeated tick takes to come and than a daily job takes to run, shorter than the hour between two ticks.
 */
export const RECENT_RUN_SECONDS = 30 * 60;

/** A row of `platform.daily_job_run` as the planner reads it. */
export interface LedgerRun {
  job: string;
  localDate: string;
  /** The instant the run is due: its local time, or the start of a delayed run. */
  scheduledFor: Date;
  /** The clock of the tick that enqueued the run. */
  enqueuedAt: Date;
}

/** A run the tick enqueues. */
export interface PlannedRun {
  job: DailyJob;
  /** The local date the job works on, in its payload and its ledger row. */
  localDate: string;
  /** The instant the run is due (stored as `scheduled_for`). */
  scheduledFor: Date;
  /** Delay of the job from the tick's clock (0 for a catch-up and for a due run whose minute has passed). */
  startAfterSeconds: number;
  /** The E.2 singleton key. */
  singletonKey: string;
  path: 'due' | 'catch-up';
}

export interface DailyPlanInput {
  orgId: string;
  /** The tick's clock. */
  now: Date;
  /** The organisation's time zone as the tick reads it. */
  timeZone: string;
  /** `platform.organization.created_at`. */
  createdAt: Date;
  /** The organisation's ledger rows of at least the current and the previous local date and every row due later. */
  ledger: readonly LedgerRun[];
  /** The earliest local date in the organisation's ledger, null when it holds none. */
  firstLocalDate: string | null;
  /** The earliest `enqueued_at` in the organisation's ledger, null when it holds none. */
  firstEnqueuedAt: Date | null;
  jobs?: readonly DailyJob[];
}

/** The runs due at the tick, in the order of `jobs`; see the file comment. */
export function planDailyRuns(input: DailyPlanInput): PlannedRun[] {
  const { orgId, now, timeZone, createdAt, ledger, firstLocalDate, firstEnqueuedAt, jobs = DAILY_JOBS } = input;
  const local = localTimeOf(now, timeZone);
  const dates = [addDays(local.date, -1), local.date];
  const wallClock = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const done = new Set<string>();
  // A job with a run that is not due to start yet or was enqueued recently: its job may still be in the queue. A run
  // enqueued "after" the tick's clock (a clock set back) counts as recent too.
  const recentFrom = now.getTime() - RECENT_RUN_SECONDS * 1000;
  const waiting = new Set<string>();
  for (const row of ledger) {
    if (row.localDate === dates[0] || row.localDate === dates[1]) done.add(`${row.job}@${row.localDate}`);
    if (row.scheduledFor.getTime() > now.getTime() || row.enqueuedAt.getTime() > recentFrom) waiting.add(row.job);
  }
  const planned: PlannedRun[] = [];
  for (const job of jobs) {
    if (waiting.has(job.name)) continue;
    const hour = Number(job.at.slice(0, 2));
    const minute = Number(job.at.slice(3, 5));
    for (const date of dates) {
      if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
      if (done.has(`${job.name}@${date}`)) continue;
      const base = { job, localDate: date, singletonKey: dailySingletonKey(job, orgId, date) };
      if (date === local.date && hour === local.hour) {
        const untilMinute = (minute - local.minute) * 60 - local.second;
        planned.push({ ...base, scheduledFor: new Date(now.getTime() + untilMinute * 1000), startAfterSeconds: Math.max(0, untilMinute), path: 'due' });
        break;
      }
      // A local time still ahead today is due at a later tick (this also spares the instant's computation).
      if (date === local.date && job.at > wallClock) continue;
      const scheduledFor = instantOfLocal(date, job.at, timeZone);
      if (scheduledFor.getTime() > now.getTime()) continue;
      if (scheduledFor.getTime() < createdAt.getTime()) continue;
      // The ledger already kept the organisation's runs at this run (see the file comment).
      const kept = (firstLocalDate !== null && firstLocalDate < date) || (firstEnqueuedAt !== null && firstEnqueuedAt.getTime() <= scheduledFor.getTime());
      if (!kept) continue;
      planned.push({ ...base, scheduledFor, startAfterSeconds: 0, path: 'catch-up' });
      break;
    }
  }
  return planned;
}
