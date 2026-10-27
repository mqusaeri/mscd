// `scheduler.tick` (E.2): hourly at minute 5 UTC. Advances the clock high-water mark of the licence rollback rule
// (D-15) and enqueues, for every active organisation, the daily jobs whose local time falls in the organisation's
// current local hour (D-07). Only jobs that have a handler in this build are enqueued, so a job of a later work
// package starts being scheduled when its handler exists.
//
// A tick plans its slot: minute 5 of the UTC hour it runs in, the instant the cron schedule names. The local hour is
// taken at the slot, so a tick that starts a few seconds early or some minutes late plans the same hour as a tick on
// time; the delay of a job to its local minute is counted from the actual start.
//
// Time zone changes (Milestone 2 D.2, risk table I, M2-06): the singleton key of a daily job holds the local date, but
// it stops a second job only while the first is still waiting or running. After a Tenant Admin changes the time zone
// (`org.updated`, see admin-users/organization.service.ts), the same local date could otherwise get a job twice (a
// zone further west reaches the job's hour of a date the old zone already ran) or not at all (a zone further east
// passed the job's hour of the date before the change). A run belongs to the local date of its singleton key, the
// "today" the job works with. For an organisation whose zone changed in the last 54 hours, the tick reads the changes
// from the organisation's audit trail and plans each local date once:
// - The zone of a slot is the zone in force at the slot's instant. A tick that starts after a change but belongs to
//   the slot before it plans that slot with the old zone, as a tick on time would.
// - The catch-up of a change belongs to the first tick whose slot is after the slot of the previous tick (the clock
//   high-water mark before this tick) and not before the change. It enqueues at once the jobs of the current local
//   date whose hour has passed. When the previous tick is not known (a clock set back), the previous slot counts as
//   the previous tick. A second tick in a slot that already had one plans nothing.
// - Before it enqueues anything, the tick replays the plans of the slots of the last 52 hours up to the previous
//   tick, catch-ups included, and leaves out a job that already ran for the current local date. Every run of a local
//   date lies in that period.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobName } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JobHandler, JobHandlerRegistry, type JobHandlerInstance } from '../../common/jobs/job-handler';
import { JOB_QUEUE, type JobQueue, type JobRun } from '../../common/jobs/job-queue';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { DAILY_JOBS, dueDailyJobs, localTimeOf, type DailyJob, type DueDailyJob, type LocalTime } from './schedules';

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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The minute of `scheduler.tick` in every UTC hour (`5 * * * *`). */
const TICK_MINUTE_MS = 5 * MINUTE_MS;
/**
 * How far back the tick replays the slots of an organisation with a time zone change. Every run of a local date lies
 * in 50 hours: from 00:05 of the date in the zone furthest east (UTC+14) to the date's last hour in the zone furthest
 * west (UTC-12); a catch-up comes later than the hour of its jobs, never earlier.
 */
export const REPLAY_MS = 52 * HOUR_MS;
/** How far back the tick reads time zone changes: the replay, the hour before its first slot and a margin. */
export const TIME_ZONE_HISTORY_MS = 54 * HOUR_MS;

/** The slot of a tick that runs at `instant`: minute 5 of the UTC hour it runs in. */
export function tickSlotOf(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS + TICK_MINUTE_MS);
}

/**
 * The zone in force at `instant`, given the changes (oldest first): the zone before the first later change, else the
 * zone after the last change, else `timeZone`.
 */
export function zoneAt(instant: Date, changes: readonly TimeZoneChange[], timeZone: string): string {
  for (const change of changes) if (change.at.getTime() > instant.getTime()) return change.from;
  return changes.length > 0 ? changes[changes.length - 1]!.to : timeZone;
}

/** Local times of recent slots by zone: successive ticks replay almost the same slots. */
const localTimes = new Map<string, LocalTime>();
function localTimeAt(slot: Date, timeZone: string): LocalTime {
  const key = `${slot.getTime()}|${timeZone}`;
  let local = localTimes.get(key);
  if (!local) {
    if (localTimes.size >= 10_000) localTimes.clear();
    local = localTimeOf(slot, timeZone);
    localTimes.set(key, local);
  }
  return local;
}

/** A run of a daily job for a local date. */
const runOf = (job: DailyJob, date: string) => `${job.prefix}@${date}`;

interface SlotPlan {
  local: LocalTime;
  /** The jobs of the slot's local hour. */
  due: DailyJob[];
  /** The jobs of the slot's local date whose hour has passed, when a change falls after the previous tick's slot. */
  catchUp: DailyJob[];
}

/** What the tick of `slot` considers before it leaves out the runs of earlier ticks. */
function slotPlan(slot: Date, previousSlot: Date, changes: readonly TimeZoneChange[], timeZone: string, jobs: readonly DailyJob[]): SlotPlan {
  const local = localTimeAt(slot, zoneAt(slot, changes, timeZone));
  const changed = changes.some((c) => c.at.getTime() > previousSlot.getTime() && c.at.getTime() <= slot.getTime());
  const plan: SlotPlan = { local, due: [], catchUp: [] };
  for (const job of jobs) {
    if (job.weekday !== undefined && job.weekday !== local.weekday) continue;
    const hour = Number(job.at.slice(0, 2));
    if (hour === local.hour) plan.due.push(job);
    else if (changed && hour < local.hour) plan.catchUp.push(job);
  }
  return plan;
}

/**
 * The daily jobs to enqueue for one organisation at `now`, given its zone (`timeZone`, the zone after the last change)
 * and its time zone changes of the last `TIME_ZONE_HISTORY_MS` (oldest first). `previousTick` is the instant of the
 * tick before (the clock high-water mark before this tick); without it the tick before is taken to be the one of the
 * previous slot. Without changes this is `dueDailyJobs` at the tick's slot.
 */
export function planDailyJobs(
  orgId: string,
  now: Date,
  timeZone: string,
  changes: readonly TimeZoneChange[],
  jobs: readonly DailyJob[] = DAILY_JOBS,
  previousTick?: Date,
): DueDailyJob[] {
  const slot = tickSlotOf(now);
  // The delay to a job's local minute counts from the actual start of the tick.
  const early = Math.round((slot.getTime() - now.getTime()) / 1000);
  const fromNow = (due: DueDailyJob): DueDailyJob => ({ ...due, startAfterSeconds: Math.max(0, due.startAfterSeconds + early) });
  const recent = changes
    .filter((c) => c.at.getTime() <= now.getTime() && c.at.getTime() > now.getTime() - TIME_ZONE_HISTORY_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (recent.length === 0) return dueDailyJobs(orgId, slot, timeZone, jobs).map(fromNow);

  // The slot of the tick before. A clock set back hides it (the mark is ahead of `now`).
  const knownSlot = previousTick && previousTick.getTime() <= now.getTime() ? tickSlotOf(previousTick) : undefined;
  if (knownSlot && knownSlot.getTime() === slot.getTime()) return [];
  const previousSlot = knownSlot ?? new Date(slot.getTime() - HOUR_MS);

  // The runs of the ticks before this one, up to the previous tick: slots after it had no tick.
  const ran = new Set<string>();
  for (let t = slot.getTime() - REPLAY_MS; t <= previousSlot.getTime(); t += HOUR_MS) {
    const earlier = slotPlan(new Date(t), new Date(t - HOUR_MS), recent, timeZone, jobs);
    for (const job of [...earlier.due, ...earlier.catchUp]) ran.add(runOf(job, earlier.local.date));
  }

  const plan = slotPlan(slot, previousSlot, recent, timeZone, jobs);
  const zone = zoneAt(slot, recent, timeZone);
  const planned: DueDailyJob[] = [];
  for (const due of dueDailyJobs(orgId, slot, zone, plan.due)) {
    if (!ran.has(runOf(due.job, plan.local.date))) planned.push(fromNow(due));
  }
  for (const job of plan.catchUp) {
    if (ran.has(runOf(job, plan.local.date))) continue;
    const key = job.allSystems ? `${job.prefix}:${orgId}:all` : `${job.prefix}:${orgId}:${plan.local.date}`;
    planned.push({ job, singletonKey: key, startAfterSeconds: 0 });
  }
  return planned;
}

/** The zone of an organisation read before its time zone changes, and those changes (oldest first). */
interface ZoneHistory {
  timeZone: string;
  changes: TimeZoneChange[];
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
    const histories = await this.zoneHistories(now);
    return this.scope.withPlatform(
      async (trx) => {
        // The mark before this tick is the instant of the tick before: only this job moves it. The row lock orders
        // ticks, and a tick that fails leaves the mark where it was, as if it had not run.
        const previous = await trx.selectFrom('platform.clock_mark').select('high_water').forUpdate().executeTakeFirst();
        // The mark only moves forward (D-15): a clock set back never lowers it.
        const mark = await trx
          .updateTable('platform.clock_mark')
          .set({ high_water: sql<Date>`greatest(high_water, ${now})` })
          .returning('high_water')
          .executeTakeFirst();
        const previousTick = previous ? new Date(previous.high_water) : undefined;
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
          // The zone read with the changes; an organisation created since then has none.
          const history = histories.get(org.id) ?? { timeZone: org.time_zone, changes: [] };
          for (const due of planDailyJobs(org.id, now, history.timeZone, history.changes, daily, previousTick)) {
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
   * The zone of every active organisation and, for those whose row changed in the last `TIME_ZONE_HISTORY_MS` (the
   * row's `updated_at` follows every change), the time zone changes of that period from the `org.updated` entries of
   * their audit trails. The zones are read before the trails: a change that commits in between is in the trail, which
   * then gives the zone of each slot, and a change that commits later is seen by the next tick as a change after this
   * tick's slot. A trail that cannot be read is logged and the organisation is planned without changes.
   */
  private async zoneHistories(now: Date): Promise<Map<string, ZoneHistory>> {
    const since = new Date(now.getTime() - TIME_ZONE_HISTORY_MS);
    const orgs = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.organization')
          .select(['id', 'schema_name', 'time_zone'])
          .select(
            sql<boolean>`updated_at > least(now(), ${now}::timestamptz) - ${`${TIME_ZONE_HISTORY_MS / 1000} seconds`}::interval`.as('changed'),
          )
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute(),
      { scope: 'job' },
    );
    const out = new Map<string, ZoneHistory>();
    for (const org of orgs) {
      out.set(org.id, { timeZone: org.time_zone, changes: [] });
      if (!org.changed) continue;
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
        const changes = rows
          .filter((r) => r.from_zone && r.to_zone)
          .map((r) => ({ at: new Date(r.occurred_at), from: r.from_zone as string, to: r.to_zone as string }));
        out.set(org.id, { timeZone: org.time_zone, changes });
      } catch (error) {
        this.logger.error({ orgId: org.id }, `Could not read the time zone changes of organisation ${org.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  }
}
