// Payload of every job of build plan E.2 and Milestone 2 J.3, by job name. Producers and handlers share these types
// through `JobQueue.send` and `@JobHandler`.
import type { JobName } from '@mscd/shared';

/** Jobs whose payload is the empty object. */
type Empty = Record<string, never>;

export interface JobPayloads {
  'scheduler.tick': Empty;
  'freshness.recompute': { msId?: string; evidenceIds?: string[]; entryIds?: string[] };
  'freshness.sweep': Empty;
  'tasks.overdue': Empty;
  'documents.review-alerts': Empty;
  'audit-prep.generate': Empty;
  'license.check': Empty;
  'packs.lifecycle': Empty;
  'edition.withdrawn-alerts': Empty;
  'link-health.plan': Empty;
  'link-health.check': { repositoryId: string; storageObjectIds: string[]; taskId?: string };
  'link-health.repository': Empty;
  'drift.evaluate': { msId?: string };
  'integrity.rehash': Empty;
  'cycle.derive': { msId?: string };
  'notifications.dispatch': { notificationIds?: string[] };
  'notifications.digest': Empty;
  'evidence-pack.build': { packId: string };
  'export.build': { taskId: string };
  'pack.install': { installId: string; objectKey: string; requestedBy: string; orgId?: string };
  'audit.verify-chain': Empty;
  'cleanup.expired': Empty;
  // Milestone 2 J.3 (written by M2-02; filled by the package named in J.3).
  /** One system, or every system of the organisation when absent (M2-05, D.6). */
  'readiness.recompute': { msId?: string };
  /** Daily per organisation (M2-05, D.4). */
  'certificate.expiry': Empty;
  /** The import to commit and its background task (M2-08). */
  'import.run': { importId: string; taskId: string };
  /** The framework versions an installation updated; the organisation is the envelope's (M2-03, E.3). */
  'applicability.sync': { frameworkVersionIds: string[]; packInstallId?: string };
  /** Daily installation-wide (M2-S10). */
  'entitlement.expiry': Empty;
  /** One domain (add, verify now) or, when absent, the hourly sweep of pending and the monthly check of verified domains (M2-S11). */
  'domain.verify': { organizationId?: string; domain?: string };
}

// Compile-time check: every job name of @mscd/shared has a payload type and nothing else does.
type MissingPayloads = Exclude<JobName, keyof JobPayloads>;
type ExtraPayloads = Exclude<keyof JobPayloads, JobName>;
export type JobPayloadsComplete = [MissingPayloads, ExtraPayloads] extends [never, never] ? true : { missing: MissingPayloads; extra: ExtraPayloads };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const payloadsComplete: JobPayloadsComplete = true;
