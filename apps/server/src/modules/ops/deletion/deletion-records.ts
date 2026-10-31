// Shared pieces of the end of contract and verified deletion (Milestone 3 D.5): the lifecycle periods of the profile,
// the deletion and export records an organisation has, the Tenant Admins that the deletion emails reach (sealed with
// platform.key while the deletion waits), the final export queued at the move to offboarding, and the steps of a purge
// as the report stores them. Used by the status moves, the deletion routes, `org.lifecycle`, `org.purge` and the
// commands of `cli/tenant.ts`. Every function runs in the caller's transaction, which has platform scope.
import { randomUUID } from 'node:crypto';
import type { OrganizationDeletionStatus } from '@mscd/shared';
import { sql } from 'kysely';
import type { JobQueue } from '../../../common/jobs/job-queue';
import type { Trx } from '../../../common/tokens';
import type { MscdConfig } from '../../../config/mscd-config';
import type { FileKeyProvider } from '../../keys/file-key-provider';

export const DAY_MS = 86_400_000;

/** Days an archived organisation reopened for an export stays read-only (D.5.1, J.8). */
export const REOPEN_DAYS = 7;

/** The lifecycle periods of the profile (D.3), in days. */
export interface LifecyclePeriods {
  offboardingDays: number;
  graceDays: number;
  minGraceDays: number;
  backupCopiesEndDays: number;
}

export function lifecyclePeriods(config: MscdConfig): LifecyclePeriods {
  const l = config.profile.lifecycle;
  return {
    offboardingDays: l.offboarding_days,
    graceDays: l.deletion_grace_days,
    minGraceDays: l.deletion_min_grace_days,
    backupCopiesEndDays: l.backup_copies_end_days,
  };
}

export function addDaysTo(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** One deletion row as the services read it. */
export interface DeletionRow {
  id: string;
  organization_id: string;
  status: OrganizationDeletionStatus;
  scheduled_for: Date;
  scheduled_by: string | null;
  reason: string | null;
  notify_emails_sealed: string | null;
  final_export_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  failed_step: string | null;
  error: string | null;
  report: unknown;
  vault_objects_deleted: string | null;
  certificate: unknown;
  certificate_signature: string | null;
  certificate_key_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const DELETION_COLUMNS = [
  'id', 'organization_id', 'status', 'scheduled_for', 'scheduled_by', 'reason', 'notify_emails_sealed', 'final_export_id', 'started_at',
  'completed_at', 'failed_step', 'error', 'report', 'vault_objects_deleted', 'certificate', 'certificate_signature', 'certificate_key_id',
  'created_at', 'updated_at',
] as const;

/** The deletion of an organisation that is not cancelled (at most one, unique index of platform/0007), or null. */
export async function openDeletion(trx: Trx, orgId: string, options: { lock?: boolean } = {}): Promise<DeletionRow | null> {
  let query = trx.selectFrom('platform.organization_deletion').select(DELETION_COLUMNS).where('organization_id', '=', orgId).where('status', '<>', 'cancelled');
  if (options.lock) query = query.forUpdate();
  return ((await query.executeTakeFirst()) as DeletionRow | undefined) ?? null;
}

/** The deletion an operator sees: the one not cancelled, else the newest cancelled one, else null. */
export async function shownDeletion(trx: Trx, orgId: string): Promise<DeletionRow | null> {
  const open = await openDeletion(trx, orgId);
  if (open) return open;
  const row = await trx
    .selectFrom('platform.organization_deletion')
    .select(DELETION_COLUMNS)
    .where('organization_id', '=', orgId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return (row as DeletionRow | undefined) ?? null;
}

/** One deletion by id. */
export async function deletionById(trx: Trx, id: string, options: { lock?: boolean } = {}): Promise<DeletionRow | null> {
  let query = trx.selectFrom('platform.organization_deletion').select(DELETION_COLUMNS).where('id', '=', id);
  if (options.lock) query = query.forUpdate();
  return ((await query.executeTakeFirst()) as DeletionRow | undefined) ?? null;
}

/** When the organisation last moved to archived (its newest status event to archived), or null. */
export async function archivedAt(trx: Trx, orgId: string): Promise<Date | null> {
  const row = await trx
    .selectFrom('platform.organization_status_event')
    .select('created_at')
    .where('organization_id', '=', orgId)
    .where('to_status', '=', 'archived')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.created_at ?? null;
}

/** When the organisation last moved to offboarding, or null. */
export async function offboardingStartedAt(trx: Trx, orgId: string): Promise<Date | null> {
  const row = await trx
    .selectFrom('platform.organization_status_event')
    .select('created_at')
    .where('organization_id', '=', orgId)
    .where('to_status', '=', 'offboarding')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.created_at ?? null;
}

/** A Tenant Admin who is told about a status change or a deletion. */
export interface TenantAdmin {
  id: string;
  email: string;
}

/** Active Tenant Admins of an organisation (active person accounts with an active membership holding `tenant_admin`). */
export async function tenantAdminsOf(trx: Trx, orgId: string): Promise<TenantAdmin[]> {
  const { rows } = await sql<TenantAdmin>`
    select u.id, u.email
      from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null
       and 'tenant_admin' = any(m.admin_roles)
       and u.kind = 'person' and u.status = 'active' and u.deleted_at is null
     order by u.email`.execute(trx);
  return rows;
}

/** Active platform operators with their email (the certificate and the failure alert reach them). */
export async function platformOperators(trx: Trx): Promise<TenantAdmin[]> {
  const { rows } = await sql<TenantAdmin>`
    select u.id, u.email
      from platform.platform_role r
      join platform.app_user u on u.id = r.user_id
     where r.role = 'platform_operator' and r.revoked_at is null
       and u.status = 'active' and u.deleted_at is null
     order by u.email`.execute(trx);
  return rows;
}

/** Additional data of the sealed email list of a deletion (`platform.key`, bound to the deletion). */
export function notifyEmailsAad(deletionId: string): string {
  return `deletion:${deletionId}`;
}

/** The email addresses sealed with platform.key, bound to the deletion; null for an empty list. */
export async function sealNotifyEmails(keys: FileKeyProvider, deletionId: string, emails: readonly string[]): Promise<string | null> {
  const unique = [...new Set(emails.map((e) => e.trim()).filter((e) => e !== ''))];
  if (unique.length === 0) return null;
  return keys.wrap(Buffer.from(JSON.stringify(unique), 'utf8'), notifyEmailsAad(deletionId));
}

/** The sealed email list of a deletion (empty for null). */
export async function openNotifyEmails(keys: FileKeyProvider, deletionId: string, sealed: string | null): Promise<string[]> {
  if (!sealed) return [];
  const plain = await keys.unwrap(sealed, notifyEmailsAad(deletionId));
  const parsed = JSON.parse(plain.toString('utf8')) as unknown;
  plain.fill(0);
  return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
}

/** The newest final export of an organisation (D.4 `is_final`), or null. */
export async function latestFinalExport(trx: Trx, orgId: string): Promise<{ id: string; status: string; completed_at: Date | null; manifest_sha256: string | null } | null> {
  const row = await trx
    .selectFrom('platform.organization_export')
    .select(['id', 'status', 'completed_at', 'manifest_sha256'])
    .where('organization_id', '=', orgId)
    .where('is_final', '=', true)
    .orderBy('requested_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Queues the final export of an organisation at its move to offboarding (D.4, D.5.1), in `trx`: an export that is already
 * queued or being built becomes the final one (one export per organisation runs at a time); otherwise a new export row
 * (`queued`, `requested_via = 'offboarding'`, `is_final`, no approval: the contract has ended and the customer must get
 * its data) and the job `org-export.build`, sent when `trx` commits. Returns the export id.
 */
export async function queueFinalExport(trx: Trx, queue: JobQueue, orgId: string, requestId?: string): Promise<string> {
  const running = await trx
    .selectFrom('platform.organization_export')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('status', 'in', ['queued', 'building'])
    .limit(1)
    .executeTakeFirst();
  if (running) {
    await trx.updateTable('platform.organization_export').set({ is_final: true }).where('id', '=', running.id).execute();
    return running.id;
  }
  const id = randomUUID();
  await trx
    .insertInto('platform.organization_export')
    .values({ id, organization_id: orgId, status: 'queued', requested_via: 'offboarding', requested_by: null, is_final: true })
    .execute();
  // The singleton key and the retry count of the export routes (org-export.service.ts, `oe:<exportId>`, one retry).
  await queue.send('org-export.build', { orgId, ...(requestId ? { requestId } : {}), payload: { exportId: id } }, { singletonKey: `oe:${id}`, retryLimit: 1 }, trx);
  return id;
}

/** The newest export of an organisation for the operator's lists (D.2 `lastExport`), or null. */
export async function lastExportOf(trx: Trx, orgId: string): Promise<{ status: string; completed_at: Date | null } | null> {
  const row = await trx
    .selectFrom('platform.organization_export')
    .select(['status', 'completed_at'])
    .where('organization_id', '=', orgId)
    .orderBy('requested_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// The purge report (D.5.2, D.5.3)
// ---------------------------------------------------------------------------------------------------------------

/** The steps of `org.purge` in order (D.5.2). */
export const PURGE_STEPS = ['check', 'access', 'accounts', 'vault', 'database', 'audit', 'organization', 'checks', 'certificate', 'emails'] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

export interface PurgeStepResult {
  step: PurgeStep;
  status: 'pending' | 'running' | 'done' | 'failed';
  at: string | null;
  detail: string | null;
  counts?: Record<string, number | boolean>;
}

export interface PurgeCheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

/** What `organization_deletion.report` holds (no personal data; the replacement map is sealed and cleared after step 6). */
export interface PurgeReport {
  steps: PurgeStepResult[];
  checks: PurgeCheckResult[];
  /** Ids of the accounts anonymised in step 3 (ids are no personal data; the check of D.5.3 reads them). */
  anonymisedUserIds?: string[];
  keptAccounts?: number;
  /** Personal value to pseudonym for step 6, sealed with platform.key; null once step 6 is done. */
  replacementsSealed?: string | null;
  /** The organisation's repositories in the customer's Microsoft 365 or Google Drive (adapter and name). */
  repositories?: { adapter: string; name: string }[];
  vault?: { objectsDeleted: number; versionsDeleted: number; retained: { key: string; retainUntil: string | null }[] };
  redaction?: { redactionId: string; redacted: number; unchanged: number; attestationSeq: number };
  anchor?: { seq: number; anchoredAt: string } | null;
  emails?: { recipients: number; sent: number };
  /** Set when `tenant purge --reapply` started this deletion after a restore (D.5.6). */
  reapplied?: { certificateId: string; originalDeletionId: string; at: string };
  /** Reminders sent before the deletion date (stage and the date they were for). */
  reminders?: { stage: string; due: string; at: string }[];
}

/** A report with every step pending. */
export function emptyReport(): PurgeReport {
  return { steps: PURGE_STEPS.map((step) => ({ step, status: 'pending', at: null, detail: null })), checks: [] };
}

/** The report of a row: its stored value with every step present, else an empty report. */
export function reportOf(value: unknown): PurgeReport {
  const base = emptyReport();
  if (typeof value !== 'object' || value === null) return base;
  const stored = value as Partial<PurgeReport>;
  const steps = PURGE_STEPS.map((step) => stored.steps?.find((s) => s.step === step) ?? base.steps.find((s) => s.step === step)!);
  return { ...stored, steps, checks: Array.isArray(stored.checks) ? stored.checks : [] };
}
