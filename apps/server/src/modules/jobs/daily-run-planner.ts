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
//   minute (0 when that minute has passed). This is the Milestone 1 behaviour of `dueDailyJobs`.
// - Catch-up: a run of the current or the previous local date whose local time has passed without a run (a tick that
//   did not come, a worker that was down, or a time zone change east). It starts at once. Only when the organisation
//   existed at the run's instant and the ledger holds a run of the organisation for an earlier local date, so a new
//   organisation or a fresh ledger does not get a burst of past runs on its first day.
// - A weekly job runs only on its weekday.
// - Per job, a tick enqueues at most one run, the earliest date first, and none while the ledger holds a run of that
//   job that is not due to start yet. Runs of one job are therefore enqueued in date order and never wait in the
//   queue together: jobs keyed `<prefix>:<org>:all` (E.2) would otherwise lose the later run to the singleton key of
//   the earlier one (E.1: at most one waiting job per key), and a job that records a state (`license.check`) would
//   otherwise record an older date after a newer one. The later date follows at the next tick.
import { addDays, instantOfLocal } from '../../common/dates';
import { DAILY_JOBS, dailySingletonKey, localTimeOf, weekdayOfDate, type DailyJob } from './schedules';

/** A row of `platform.daily_job_run` as the planner reads it. */
export interface LedgerRun {
  job: string;
  localDate: string;
  /** The instant the run is due: its local time, or the start of a delayed run. */
  scheduledFor: Date;
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
  jobs?: readonly DailyJob[];
}

/** The runs due at the tick, in the order of `jobs`; see the file comment. */
export function planDailyRuns(input: DailyPlanInput): PlannedRun[] {
  const { orgId, now, timeZone, createdAt, ledger, firstLocalDate, jobs = DAILY_JOBS } = input;
  const local = localTimeOf(now, timeZone);
  const dates = [addDays(local.date, -1), local.date];
  const done = new Set(ledger.map((r) => `${r.job}@${r.localDate}`));
  // A job with a run that is not due to start yet: its job is still waiting in the queue.
  const waiting = new Set(ledger.filter((r) => r.scheduledFor.getTime() > now.getTime()).map((r) => r.job));
  const planned: PlannedRun[] = [];
  for (const job of jobs) {
    if (waiting.has(job.name)) continue;
    const [hour, minute] = job.at.split(':').map(Number) as [number, number];
    for (const date of dates) {
      if (job.weekday !== undefined && weekdayOfDate(date) !== job.weekday) continue;
      if (done.has(`${job.name}@${date}`)) continue;
      const base = { job, localDate: date, singletonKey: dailySingletonKey(job, orgId, date) };
      if (date === local.date && hour === local.hour) {
        const untilMinute = (minute - local.minute) * 60 - local.second;
        planned.push({ ...base, scheduledFor: new Date(now.getTime() + untilMinute * 1000), startAfterSeconds: Math.max(0, untilMinute), path: 'due' });
        break;
      }
      const scheduledFor = instantOfLocal(date, job.at, timeZone);
      if (scheduledFor.getTime() > now.getTime()) continue;
      if (scheduledFor.getTime() < createdAt.getTime()) continue;
      if (firstLocalDate === null || firstLocalDate >= date) continue;
      planned.push({ ...base, scheduledFor, startAfterSeconds: 0, path: 'catch-up' });
      break;
    }
  }
  return planned;
}
