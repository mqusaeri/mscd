// `scheduler.tick` (E.2): hourly at minute 5 UTC. Advances the clock high-water mark of the licence rollback rule
// (D-15) and enqueues, for every active organisation, the runs of its daily jobs that are due (D-07). Only jobs that
// have a handler in this build are enqueued, so a job of a later work package starts being scheduled when its
// handler exists.
//
// Organisation status (Milestone 2 J.8, K.6, M2-S09): only organisations whose status is `active` get daily runs. A
// `suspended`, `offboarding` or `archived` organisation gets none (no reminders, sweeps, alerts or licence checks for
// people who cannot act on them) and writes no ledger rows. The tick reads the status in its own transaction, so a
// status change counts from the next tick in every worker, whatever the organisation caches hold. When the operator
// makes the organisation active again, the next tick plans its runs as before, with the catch-up of the current and the
// previous local date of the ledger rules below.
//
// Run ledger (Milestone 2 D.2, risk table I; orchestrator decision between waves 2a and 2b, migration
// `platform/0006_daily_job_run.sql`): a run is one organisation, one daily job and one local date. The tick reads each
// organisation's current time zone with a plain read (no row lock on organisation rows) and its ledger rows, and
// `planDailyRuns` (daily-run-planner.ts) names the due runs: the runs of the tick's local hour, delayed to their local
// minute, and the runs of the current and the previous local date whose local time passed without a run while the
// ledger kept the organisation's runs (after its earliest local date or `enqueued_at`). For each run the tick inserts
// its ledger row
// (`insert ... on conflict do nothing returning`) and sends the job only when the row is new. The job carries the run's
// date in its payload (`localDate`) and works on that date (`Clock.runDate`), so a time zone change between the tick
// and the job's start cannot move the job to another date. Each daily job therefore runs at most once per local date
// of its organisation, a missed hour or a time zone change in either direction is caught up, and late, early, repeated
// or missing ticks and a clock set back change nothing of that (within the limits in daily-run-planner.ts).
//
// Atomicity: the ledger rows and the jobs are written in one database transaction. The pg-boss driver sends through
// that transaction (`db: fromKysely(trx)`, pg-boss 12.35), the BullMQ driver writes its outbox row in it, and the
// in-memory driver queues the job after the commit. A failure rolls back both the rows and the jobs, and the retried
// tick (E.2 retries 3) or the next tick plans them again, so a run is neither lost nor created twice.
//
// Singleton keys (E.1: at most one waiting or active job per key): the planner enqueues no run of a job while an
// earlier run of it may still be queued (daily-run-planner.ts). When the queue still drops a send (`send` resolves to
// null, which pg-boss reports inside the transaction), the job that holds the key decides:
// - a key with a date (`<prefix>:<org>:<date>`): that job is this run (sent before the ledger existed), so the row
//   stays and the run counts as queued;
// - a key `<prefix>:<org>:all` (readiness.recompute, drift.evaluate, cycle.derive): that job is a run of another date
//   that is still waiting or working (a queue delay of more than `RECENT_RUN_SECONDS`), or a job queued for every
//   system outside the daily runs (today every command, and every job a command starts, names its system). The tick
//   deletes the row it inserted, in the same transaction, and a later tick plans the run again as a catch-up once the
//   key is free. The ledger still keeps the run to one per date. Limits (daily-run-planner.ts): the run is lost when
//   the drop happens at the last tick before its date leaves the window of the current and the previous local date,
//   or when its row would have been the organisation's first ledger row on the ledger's first local date.
// The BullMQ driver decides at relay time and cannot report a drop to the tick; there the planner's rule alone keeps
// the sends apart, which holds while a queued daily job starts and ends within `RECENT_RUN_SECONDS`.
//
// Ordering: the tick first moves the clock high-water mark (`platform.clock_mark`, a single row). Its row lock is held
// to the commit, so a second tick running at the same time waits there and then reads the ledger rows of the first.
// The ledger rows reference their organisation, which takes a key share lock on its row; the organisation PATCH locks
// its row `FOR NO KEY UPDATE`, which does not conflict with it (admin-users/organization.service.ts).
//
// Cleanup: the tick deletes ledger rows more than `LEDGER_RETENTION_DAYS` days old.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobName } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays } from '../../common/dates';
import { JobHandler, JobHandlerRegistry, type JobHandlerInstance } from '../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../common/jobs/job-queue';
import { TenantScope } from '../tenancy/tenant-scope';
import { planDailyRuns, type LedgerRun, type PlannedRun } from './daily-run-planner';
import { DAILY_JOBS, type DailyJob } from './schedules';

export interface TickRun {
  orgId: string;
  name: JobName;
  singletonKey: string;
  startAfterSeconds: number;
  localDate: string;
  path: PlannedRun['path'];
}

export interface TickResult {
  highWater: string;
  organisations: number;
  /** Runs whose ledger row this tick inserted and whose job it sent. */
  enqueued: TickRun[];
  /** Runs whose send the queue dropped for a key `<prefix>:<org>:all` held by another job: no row, a later tick retries. */
  deferred: TickRun[];
  /** Runs whose send the queue dropped for a key with their date: the job holding it is this run, the row stays. */
  alreadyQueued: TickRun[];
  /** Ledger rows deleted because they are older than `LEDGER_RETENTION_DAYS`. */
  ledgerRowsDeleted: number;
}

/** Ledger rows are kept this many days after their local date. */
export const LEDGER_RETENTION_DAYS = 14;

/**
 * The tick reads the ledger rows from this many days before the UTC date of its clock. The current local date of any
 * zone lies within a day of the UTC date, so this covers the current and the previous local date with a margin.
 */
const LEDGER_READ_DAYS = 3;

@Injectable()
@JobHandler('scheduler.tick', { concurrency: 1, scope: 'installation' })
export class SchedulerTickJob implements JobHandlerInstance<'scheduler.tick'> {
  private readonly logger = new Logger('scheduler.tick');

  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly registry: JobHandlerRegistry,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {}

  async handle(job: JobRun<'scheduler.tick'>): Promise<void> {
    const result = await this.tick(job.env.requestId);
    this.logger.log(
      {
        jobId: job.id,
        attempt: job.attempt,
        organisations: result.organisations,
        enqueued: result.enqueued.length,
        caughtUp: result.enqueued.filter((e) => e.path === 'catch-up').length,
        deferred: result.deferred.length,
        alreadyQueued: result.alreadyQueued.length,
        ledgerRowsDeleted: result.ledgerRowsDeleted,
        highWater: result.highWater,
      },
      'scheduler.tick done',
    );
  }

  /** One tick at the clock's current instant. */
  async tick(requestId?: string): Promise<TickResult> {
    const now = this.clock.now();
    const handled = new Set(this.registry.discover().map((h) => h.metadata.name));
    const daily: DailyJob[] = DAILY_JOBS.filter((d) => handled.has(d.name));
    const utcDate = now.toISOString().slice(0, 10);
    return this.scope.withPlatform(
      async (trx) => {
        // The mark only moves forward (D-15): a clock set back never lowers it. The row lock orders ticks (see above).
        const mark = await trx
          .updateTable('platform.clock_mark')
          .set({ high_water: sql<Date>`greatest(high_water, ${now})` })
          .returning('high_water')
          .executeTakeFirst();
        const deleted = await trx
          .deleteFrom('platform.daily_job_run')
          .where('local_date', '<', addDays(utcDate, -LEDGER_RETENTION_DAYS))
          .executeTakeFirst();
        // Active organisations only (see "Organisation status" above).
        const orgs = await trx
          .selectFrom('platform.organization')
          .select(['id', 'time_zone', 'created_at'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('slug')
          .execute();
        const ledger = new Map<string, LedgerRun[]>();
        const recent = await trx
          .selectFrom('platform.daily_job_run')
          .select(['organization_id', 'job', 'local_date', 'scheduled_for', 'enqueued_at'])
          .where('local_date', '>=', addDays(utcDate, -LEDGER_READ_DAYS))
          .execute();
        for (const row of recent) {
          const runs = ledger.get(row.organization_id) ?? [];
          runs.push({ job: row.job, localDate: row.local_date, scheduledFor: new Date(row.scheduled_for), enqueuedAt: new Date(row.enqueued_at) });
          ledger.set(row.organization_id, runs);
        }
        const firsts = await trx
          .selectFrom('platform.daily_job_run')
          .select(['organization_id', (eb) => eb.fn.min<string>('local_date').as('date'), (eb) => eb.fn.min<Date>('enqueued_at').as('enqueued')])
          .groupBy('organization_id')
          .execute();
        const first = new Map(firsts.map((f) => [f.organization_id, { localDate: f.date, enqueuedAt: new Date(f.enqueued) }]));

        const enqueued: TickRun[] = [];
        const deferred: TickRun[] = [];
        const alreadyQueued: TickRun[] = [];
        for (const org of orgs) {
          const runs = planDailyRuns({
            orgId: org.id,
            now,
            timeZone: org.time_zone,
            createdAt: new Date(org.created_at),
            ledger: ledger.get(org.id) ?? [],
            firstLocalDate: first.get(org.id)?.localDate ?? null,
            firstEnqueuedAt: first.get(org.id)?.enqueuedAt ?? null,
            jobs: daily,
          });
          for (const run of runs) {
            // The row first: a run whose row exists (another tick, a retry) is not sent again.
            const inserted = await trx
              .insertInto('platform.daily_job_run')
              .values({ organization_id: org.id, job: run.job.name, local_date: run.localDate, scheduled_for: run.scheduledFor, enqueued_at: now })
              .onConflict((oc) => oc.columns(['organization_id', 'job', 'local_date']).doNothing())
              .returning('job')
              .executeTakeFirst();
            if (!inserted) continue;
            const jobId = await this.jobs.send(
              run.job.name,
              { orgId: org.id, requestId, payload: { localDate: run.localDate } },
              { singletonKey: run.singletonKey, retryLimit: run.job.retryLimit, ...(run.startAfterSeconds > 0 ? { startAfterSeconds: run.startAfterSeconds } : {}) },
              trx,
            );
            const entry: TickRun = {
              orgId: org.id,
              name: run.job.name,
              singletonKey: run.singletonKey,
              startAfterSeconds: run.startAfterSeconds,
              localDate: run.localDate,
              path: run.path,
            };
            if (jobId !== null) {
              enqueued.push(entry);
            } else if (run.job.allSystems) {
              // Another job holds the key `<prefix>:<org>:all`: no run now, a later tick catches it up (see above).
              await trx
                .deleteFrom('platform.daily_job_run')
                .where('organization_id', '=', org.id)
                .where('job', '=', run.job.name)
                .where('local_date', '=', run.localDate)
                .execute();
              deferred.push(entry);
            } else {
              alreadyQueued.push(entry);
            }
          }
        }
        if (deferred.length > 0 || alreadyQueued.length > 0) {
          this.logger.warn(
            {
              deferred: deferred.map((d) => `${d.orgId} ${d.name}@${d.localDate}`),
              alreadyQueued: alreadyQueued.map((d) => `${d.orgId} ${d.name}@${d.localDate}`),
            },
            'scheduler.tick: the queue dropped sends of daily runs because jobs with their singleton keys are queued',
          );
        }
        return {
          highWater: (mark?.high_water ?? now).toISOString(),
          organisations: orgs.length,
          enqueued,
          deferred,
          alreadyQueued,
          ledgerRowsDeleted: Number(deleted.numDeletedRows),
        };
      },
      { scope: 'job', requestId },
    );
  }
}
