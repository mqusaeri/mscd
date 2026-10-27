// `scheduler.tick` (E.2): hourly at minute 5 UTC. Advances the clock high-water mark of the licence rollback rule
// (D-15) and enqueues, for every active organisation, the daily jobs whose local time falls in the organisation's
// current local hour (D-07). Only jobs that have a handler in this build are enqueued, so a job of a later work
// package starts being scheduled when its handler exists.
//
// Time zone changes (Milestone 2 D.2, risk table I, M2-06): the singleton key of a daily job holds the local date, but
// it stops a second job only while the first is still waiting or running. After a Tenant Admin changes the time zone
// (`org.updated`, see admin-users/organization.service.ts), the same local date could otherwise get a job twice (a
// zone further west reaches the job's hour of a date the old zone already ran) or not at all (a zone further east
// passed the job's hour of the date before the change). A run belongs to the local date of its singleton key, the
// "today" the job works with. For an organisation whose zone changed in the last 50 hours, the tick reads the
// changes from the organisation's audit trail and plans each local date once: a job that already ran for the date
// under an earlier zone is not enqueued again, and at the first tick after the change a job whose hour of the
// current local date has passed, and that no earlier zone ran for that date, is enqueued at once.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobName } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { localDate } from '../../common/dates';
import { JobHandler, JobHandlerRegistry, type JobHandlerInstance } from '../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../common/jobs/job-queue';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { DAILY_JOBS, dueDailyJobs, localTimeOf, type DailyJob, type DueDailyJob } from './schedules';

export interface TickResult {
  highWater: string;
  organisations: number;
  enqueued: { orgId: string; name: JobName; singletonKey: string; startAfterSeconds: number }[];
}

/** A time zone change of an organisation, from its `org.updated` audit entry. */
export interface TimeZoneChange {
  at: Date;
  from: string;
  to: string;
}

/** How far back the tick looks for time zone changes: two local days and a margin. */
export const TIME_ZONE_HISTORY_MS = 50 * 3_600_000;
/** The interval of `scheduler.tick` (hourly): a change younger than this was not seen by the previous tick. */
export const TICK_INTERVAL_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Local wall-clock time minus UTC at an instant, in milliseconds (positive east of Greenwich). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant of a local wall-clock time `HH:MM` on a local date `YYYY-MM-DD` in a time zone. */
export function instantOfLocal(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  // A daylight saving change between the guess and the result moves the offset once.
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * The instant of the `scheduler.tick` run that enqueued a daily job for a local date: the first tick (minute 5 UTC)
 * in the job's local hour.
 */
function enqueueTickOf(date: string, job: DailyJob, timeZone: string): Date {
  const hourStart = instantOfLocal(date, `${job.at.slice(0, 2)}:00`, timeZone);
  const minute = new Date(hourStart).getUTCMinutes();
  return new Date(hourStart.getTime() + (((5 - minute) % 60) + 60) % 60 * MINUTE_MS);
}

/**
 * The local dates for which `job` was enqueued under the earlier zones of `changes` (sorted by time): each earlier zone
 * is in force from the previous change (or `since`) until its change. A run belongs to the local date of the zone in
 * force when it was enqueued, the date of its singleton key and the "today" the job works with.
 */
export function earlierRunDates(job: DailyJob, changes: readonly TimeZoneChange[], since: Date): Set<string> {
  const dates = new Set<string>();
  let start = since;
  for (const change of changes) {
    const zone = change.from;
    if (change.at.getTime() > start.getTime()) {
      // Every local date of the earlier zone that its period touches, one day either side; half-day steps, so no
      // date is stepped over on a day of daylight saving change.
      for (let t = start.getTime() - DAY_MS; t <= change.at.getTime() + DAY_MS; t += DAY_MS / 2) {
        const day = localDate(new Date(t), zone);
        if (dates.has(day)) continue;
        const slot = instantOfLocal(day, job.at, zone);
        if (job.weekday !== undefined && localTimeOf(slot, zone).weekday !== job.weekday) continue;
        const tick = enqueueTickOf(day, job, zone);
        if (tick.getTime() >= start.getTime() && tick.getTime() < change.at.getTime()) dates.add(day);
      }
    }
    start = change.at;
  }
  return dates;
}

/**
 * The daily jobs to enqueue for one organisation at `now` in its current zone, given its time zone changes of the
 * last `TIME_ZONE_HISTORY_MS` (oldest first). Without changes this is `dueDailyJobs`.
 */
export function planDailyJobs(
  orgId: string,
  now: Date,
  timeZone: string,
  changes: readonly TimeZoneChange[],
  jobs: readonly DailyJob[] = DAILY_JOBS,
): DueDailyJob[] {
  const due = dueDailyJobs(orgId, now, timeZone, jobs);
  const recent = changes.filter((c) => c.at.getTime() <= now.getTime() && c.at.getTime() > now.getTime() - TIME_ZONE_HISTORY_MS);
  if (recent.length === 0) return due;
  const since = new Date(now.getTime() - TIME_ZONE_HISTORY_MS);
  const local = localTimeOf(now, timeZone);
  const ranToday = (job: DailyJob) => earlierRunDates(job, recent, since).has(local.date);
  const planned = due.filter((d) => !ranToday(d.job));
  const last = recent[recent.length - 1]!;
  if (now.getTime() - last.at.getTime() < TICK_INTERVAL_MS) {
    // First tick after the change: the jobs of today whose hour passed before this tick, and that no earlier zone ran.
    for (const job of jobs) {
      const hour = Number(job.at.slice(0, 2));
      if (hour >= local.hour) continue;
      if (job.weekday !== undefined && job.weekday !== local.weekday) continue;
      if (ranToday(job)) continue;
      const key = job.allSystems ? `${job.prefix}:${orgId}:all` : `${job.prefix}:${orgId}:${local.date}`;
      planned.push({ job, singletonKey: key, startAfterSeconds: 0 });
    }
  }
  return planned;
}

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
      { jobId: job.id, attempt: job.attempt, organisations: result.organisations, enqueued: result.enqueued.length, highWater: result.highWater },
      'scheduler.tick done',
    );
  }

  /** One tick at the clock's current instant. */
  async tick(requestId?: string): Promise<TickResult> {
    const now = this.clock.now();
    const handled = new Set(this.registry.discover().map((h) => h.metadata.name));
    const daily: DailyJob[] = DAILY_JOBS.filter((d) => handled.has(d.name));
    const changes = await this.recentTimeZoneChanges(now);
    return this.scope.withPlatform(
      async (trx) => {
        // The mark only moves forward (D-15): a clock set back never lowers it.
        const mark = await trx
          .updateTable('platform.clock_mark')
          .set({ high_water: sql<Date>`greatest(high_water, ${now})` })
          .returning('high_water')
          .executeTakeFirst();
        const orgs = await trx
          .selectFrom('platform.organization')
          .select(['id', 'time_zone'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .orderBy('slug')
          .execute();
        const enqueued: TickResult['enqueued'] = [];
        for (const org of orgs) {
          for (const due of planDailyJobs(org.id, now, org.time_zone, changes.get(org.id) ?? [], daily)) {
            await this.jobs.send(
              due.job.name,
              { orgId: org.id, requestId, payload: {} },
              { singletonKey: due.singletonKey, retryLimit: due.job.retryLimit, ...(due.startAfterSeconds > 0 ? { startAfterSeconds: due.startAfterSeconds } : {}) },
              trx,
            );
            enqueued.push({ orgId: org.id, name: due.job.name, singletonKey: due.singletonKey, startAfterSeconds: due.startAfterSeconds });
          }
        }
        return { highWater: (mark?.high_water ?? now).toISOString(), organisations: orgs.length, enqueued };
      },
      { scope: 'job', requestId },
    );
  }

  /**
   * Time zone changes of the last `TIME_ZONE_HISTORY_MS` per organisation, oldest first, from the `org.updated`
   * entries of the organisations' audit trails. Only organisations whose row changed in that period are read (the
   * row's `updated_at` follows every change). A trail that cannot be read is logged and planned without changes.
   */
  private async recentTimeZoneChanges(now: Date): Promise<Map<string, TimeZoneChange[]>> {
    const since = new Date(now.getTime() - TIME_ZONE_HISTORY_MS);
    const changed = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select(['id', 'schema_name'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where('updated_at', '>', sql<Date>`least(now(), ${now}::timestamptz) - ${`${TIME_ZONE_HISTORY_MS / 1000} seconds`}::interval`)
          .execute(),
      { scope: 'job' },
    );
    const out = new Map<string, TimeZoneChange[]>();
    for (const org of changed) {
      try {
        const rows = await this.scope.withTenant(systemContextOf({ id: org.id, schema: org.schema_name }), async (trx) => {
          const { rows: found } = await sql<{ occurred_at: Date; from_zone: string | null; to_zone: string | null }>`
            select occurred_at, before_data->>'timeZone' as from_zone, after_data->>'timeZone' as to_zone
              from audit_trail
             where entity_type = 'organization' and entity_id = ${org.id} and action = 'org.updated'
               and occurred_at > ${since} and occurred_at <= ${now}
               and before_data ? 'timeZone' and after_data ? 'timeZone'
             order by occurred_at, seq`.execute(trx);
          return found;
        });
        const list = rows
          .filter((r) => r.from_zone && r.to_zone)
          .map((r) => ({ at: new Date(r.occurred_at), from: r.from_zone as string, to: r.to_zone as string }));
        if (list.length > 0) out.set(org.id, list);
      } catch (error) {
        this.logger.error({ orgId: org.id }, `Could not read the time zone changes of organisation ${org.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  }
}
