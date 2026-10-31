// Schedules of build plan E.2, Milestone 2 J.3 and Milestone 3 J.3. Installation-wide jobs run on cron schedules in UTC; daily jobs of
// an organisation are enqueued by `scheduler.tick` in the hour of the organisation's local time (D-07), with a
// singleton key that includes the local date (or `all` for jobs that run for every system). Which runs a tick
// enqueues, with the run ledger of Milestone 2 D.2, is decided by `planDailyRuns` (daily-run-planner.ts).
import type { JobName } from '@mscd/shared';

/** Cron jobs of E.2 (UTC). `notifications.dispatch` is the 5 minute sweep of E.6. */
export const CRON_SCHEDULES: readonly { name: JobName; cron: string; retryLimit: number }[] = [
  { name: 'scheduler.tick', cron: '5 * * * *', retryLimit: 3 },
  { name: 'packs.lifecycle', cron: '10 0 * * *', retryLimit: 3 },
  { name: 'audit.verify-chain', cron: '0 4 * * *', retryLimit: 2 },
  { name: 'cleanup.expired', cron: '20 * * * *', retryLimit: 3 },
  { name: 'notifications.dispatch', cron: '*/5 * * * *', retryLimit: 5 },
  // Milestone 2 J.3 (M2-S11): the TXT records of email domains, hourly for pending domains (7 days, then failed) and
  // every 30 days for verified ones. It works on every organisation at once, so it is a cron job and not a daily job
  // of `scheduler.tick`. Its handler exists only with tenancy.mode multi, so single tenancy never schedules it.
  { name: 'domain.verify', cron: '35 * * * *', retryLimit: 1 },
  // Milestone 3 J.3 (M3-03): the organisation lifecycle (D.5.1), hourly at minute 20 in platform scope, because the run
  // ledger of the daily jobs skips organisations that are not active. In single tenancy its runs do nothing.
  { name: 'org.lifecycle', cron: '20 * * * *', retryLimit: 3 },
];

/** Retry limit of a cron job (E.2); 3 for a name without an entry in `CRON_SCHEDULES`. */
export function cronRetryLimit(name: JobName): number {
  return CRON_SCHEDULES.find((s) => s.name === name)?.retryLimit ?? 3;
}

export interface DailyJob {
  name: JobName;
  /** Local time `HH:MM`. */
  at: string;
  /** Singleton key prefix; the key is `<prefix>:<org>:<local date>` (E.2). */
  prefix: string;
  /** Jobs that take a system id have the E.2 key `<prefix>:<org>:all` when they run for every system. */
  allSystems?: boolean;
  /** Day of the week (0 Sunday) when the job runs weekly only. */
  weekday?: number;
  retryLimit: number;
}

/** Daily jobs of E.2 that `scheduler.tick` enqueues per organisation, in local time. */
export const DAILY_JOBS: readonly DailyJob[] = [
  { name: 'license.check', at: '00:05', prefix: 'lc', retryLimit: 3 },
  { name: 'tasks.overdue', at: '00:15', prefix: 'to', retryLimit: 3 },
  { name: 'audit-prep.generate', at: '00:30', prefix: 'ap', retryLimit: 3 },
  { name: 'freshness.sweep', at: '01:00', prefix: 'fs', retryLimit: 3 },
  { name: 'link-health.plan', at: '02:00', prefix: 'lhp', retryLimit: 3 },
  { name: 'link-health.repository', at: '02:30', prefix: 'lhr', retryLimit: 3 },
  // Milestone 2 J.3 (M2-05): clause readiness of every system (`rr:<org>:all`, the key of D.6 per organisation).
  { name: 'readiness.recompute', at: '02:30', prefix: 'rr', allSystems: true, retryLimit: 3 },
  { name: 'drift.evaluate', at: '02:45', prefix: 'de', allSystems: true, retryLimit: 3 },
  { name: 'integrity.rehash', at: '03:00', prefix: 'ir', weekday: 0, retryLimit: 3 },
  { name: 'cycle.derive', at: '03:15', prefix: 'cd', allSystems: true, retryLimit: 3 },
  // Milestone 3 J.3 (M3-06, D.8): opens the disposal reviews of records whose retention period has ended.
  { name: 'retention.review', at: '03:15', prefix: 'rt', retryLimit: 3 },
  // Milestone 2 J.3 (M2-05): certificate notices 90, 30 and 7 days ahead and the lapse to expired (D.4).
  { name: 'certificate.expiry', at: '06:00', prefix: 'ce', retryLimit: 3 },
  // Milestone 2 J.3 (M2-S10): entitlement notices to the operators (30, 7, 1 days) and Tenant Admins (30, 7 days).
  // Its handler exists only with tenancy.mode multi, so single tenancy never schedules it.
  { name: 'entitlement.expiry', at: '06:15', prefix: 'ee', retryLimit: 3 },
  { name: 'documents.review-alerts', at: '06:30', prefix: 'dra', retryLimit: 3 },
  // Milestone 3 J.3 (M3-07, D.9): opens the periodic access reviews that are due and sends their notices.
  { name: 'access-review.open', at: '06:30', prefix: 'ax', retryLimit: 3 },
  { name: 'notifications.digest', at: '07:00', prefix: 'ndg', retryLimit: 3 },
  // Milestone 3 J.3 (M3-04, D.6.2): notices of requests from one person due within 24 hours and overdue.
  { name: 'privacy.deadlines', at: '08:00', prefix: 'pd', retryLimit: 3 },
  // Milestone 3 J.3 (M3-05, D.7): read confirmation reminders, excusals and the overdue digest.
  { name: 'acknowledgement.reminders', at: '08:10', prefix: 'ak', retryLimit: 3 },
];

/** Local wall clock of an instant in a time zone. */
export interface LocalTime {
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 Sunday to 6 Saturday. */
  weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const localTimeFormats = new Map<string, Intl.DateTimeFormat>();

/** The local date, hour, minute, second and weekday of `instant` in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  let format = localTimeFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    localTimeFormats.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(instant)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour ?? 0) % 24,
    minute: Number(parts.minute ?? 0),
    second: Number(parts.second ?? 0),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** The day of the week of a local date `YYYY-MM-DD` (0 Sunday). */
export function weekdayOfDate(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** The E.2 singleton key of a run of a daily job: `<prefix>:<org>:<local date>`, or `<prefix>:<org>:all`. */
export function dailySingletonKey(job: DailyJob, orgId: string, date: string): string {
  return job.allSystems ? `${job.prefix}:${orgId}:all` : `${job.prefix}:${orgId}:${date}`;
}
