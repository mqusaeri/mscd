// Payload of every job of build plan E.2 and Milestone 2 J.3, by job name. Producers and handlers share these types
// through `JobQueue.send` and `@JobHandler`.
import type { JobName } from '@mscd/shared';

/** Jobs whose payload is the empty object. */
type Empty = Record<string, never>;

/**
 * A daily job of E.2 that `scheduler.tick` enqueues per organisation (Milestone 2 D.2): the local date of its run, the
 * date of its row in `platform.daily_job_run`. The job works on that date (`Clock.runDate`), so a time zone change
 * between the tick and the job's start cannot move it to another day. Absent when the job is sent another way.
 */
export interface DailyRun {
  localDate?: string;
}

export interface JobPayloads {
  'scheduler.tick': Empty;
  'freshness.recompute': { msId?: string; evidenceIds?: string[]; entryIds?: string[] };
  'freshness.sweep': DailyRun;
  'tasks.overdue': DailyRun;
  'documents.review-alerts': DailyRun;
  'audit-prep.generate': DailyRun;
  'license.check': DailyRun;
  'packs.lifecycle': Empty;
  'edition.withdrawn-alerts': Empty;
  'link-health.plan': DailyRun;
  'link-health.check': { repositoryId: string; storageObjectIds: string[]; taskId?: string };
  'link-health.repository': DailyRun;
  'drift.evaluate': { msId?: string } & DailyRun;
  'integrity.rehash': DailyRun;
  'cycle.derive': { msId?: string } & DailyRun;
  'notifications.dispatch': { notificationIds?: string[] };
  'notifications.digest': DailyRun;
  'evidence-pack.build': { packId: string };
  'export.build': { taskId: string };
  'pack.install': { installId: string; objectKey: string; requestedBy: string; orgId?: string };
  'audit.verify-chain': Empty;
  'cleanup.expired': Empty;
  // Milestone 2 J.3 (written by M2-02; filled by the package named in J.3).
  /** One system, or every system of the organisation when absent (M2-05, D.6). */
  'readiness.recompute': { msId?: string } & DailyRun;
  /** Daily per organisation (M2-05, D.4). */
  'certificate.expiry': DailyRun;
  /** The import to commit and its background task (M2-08). */
  'import.run': { importId: string; taskId: string };
  /** The framework versions an installation updated; the organisation is the envelope's (M2-03, E.3). */
  'applicability.sync': { frameworkVersionIds: string[]; packInstallId?: string };
  /** Daily per organisation in multi tenancy, on the date of its run (M2-S10). */
  'entitlement.expiry': DailyRun;
  /** One domain (add, verify now) or, when absent, the hourly sweep of pending and the monthly check of verified domains (M2-S11). */
  'domain.verify': { organizationId?: string; domain?: string };
}

// Compile-time check: every job name of @mscd/shared has a payload type and nothing else does.
type MissingPayloads = Exclude<JobName, keyof JobPayloads>;
type ExtraPayloads = Exclude<keyof JobPayloads, JobName>;
export type JobPayloadsComplete = [MissingPayloads, ExtraPayloads] extends [never, never] ? true : { missing: MissingPayloads; extra: ExtraPayloads };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const payloadsComplete: JobPayloadsComplete = true;
