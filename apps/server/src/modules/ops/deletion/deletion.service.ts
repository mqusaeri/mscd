// The verified deletion of an archived organisation as the platform operator sees it (Milestone 3 D.1, D.5; M3-03):
//   - `GET /ops/organizations/{org}/deletion`: the deletion record with its dates, steps, checks and certificate id;
//   - `POST /ops/organizations/{org}/deletion`: schedule or move the date (not earlier than archiving plus
//     `lifecycle.deletion_min_grace_days`, never in the past), with the slug again;
//   - `POST .../deletion/cancel`: cancel a scheduled deletion (the organisation stays archived; reopening it needs a
//     scheduled deletion, J.8);
//   - `POST .../deletion/retry`: run a failed purge again from its failed step;
//   - `GET .../deletion/certificate`: the signed certificate of a completed deletion as a JSON file.
// Multi tenancy only: single tenancy answers 409 `conflict` with messageKey `single_tenancy` (the customer controls the
// deletion of an on-premise installation, A.2). Refusals: 409 `deletion_not_archived`, `deletion_too_soon`,
// `deletion_in_progress` (J.6). Every change runs in platform scope and is audited in the platform chain
// (`ops.deletion_scheduled`, `ops.deletion_cancelled`, `ops.deletion_retried`). The command line (`tenant deletion
// show|schedule|cancel|run`) uses the same service with `CLI_OPERATOR`.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OrganizationDeletionResult, OrganizationDeletionSchedule, OrganizationDeletionStep, OrganizationDeletionView } from '@mscd/shared';
import { Clock } from '../../../common/clock';
import { localDate } from '../../../common/dates';
import { JOB_QUEUE, type JobQueue } from '../../../common/jobs/job-queue';
import { ConflictError, NotFoundError, ProblemError } from '../../../common/problems';
import { currentRequestId } from '../../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Trx } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import type { FileKeyProvider } from '../../keys/file-key-provider';
import { PLATFORM_KEY_PROVIDER } from '../../keys/secret-box';
import { TenantScope } from '../../tenancy/tenant-scope';
import { singleTenancyRefusal, unknownOrganisation, type OperatorActor } from '../organizations.service';
import { certificateFileName, certificateFileText, type DeletionCertificate } from './certificate';
import {
  addDaysTo,
  archivedAt,
  deletionById,
  latestFinalExport,
  lifecyclePeriods,
  openDeletion,
  reportOf,
  sealNotifyEmails,
  shownDeletion,
  tenantAdminsOf,
  type DeletionRow,
} from './deletion-records';
import { confirmationMismatch } from './organization-transitions';

/** The organisation row the deletion routes read. */
interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  time_zone: string;
}

/** A certificate file to download. */
export interface CertificateFile {
  fileName: string;
  text: string;
  certificateId: string;
}

function conflict(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('conflict', { detail: en, messageKey, messages: { en, id } });
}

@Injectable()
export class DeletionService {
  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(PLATFORM_KEY_PROVIDER) private readonly keys: FileKeyProvider,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private assertMulti(): void {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
  }

  /** `GET /ops/organizations/{org}/deletion`: 404 for an unknown organisation or one without a deletion. */
  async get(slug: string): Promise<OrganizationDeletionView> {
    this.assertMulti();
    return this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug);
        const row = await shownDeletion(trx, org.id);
        if (!row) throw new NotFoundError(`Organisation ${slug} has no deletion`);
        return this.view(trx, org, row);
      },
      { scope: 'operator' },
    );
  }

  /** `POST /ops/organizations/{org}/deletion`: schedule or move the date of the deletion of an archived organisation. */
  async schedule(actor: OperatorActor, slug: string, body: OrganizationDeletionSchedule): Promise<OrganizationDeletionResult> {
    this.assertMulti();
    const requestId = currentRequestId();
    const now = this.clock.now();
    const scheduledFor = new Date(body.scheduledFor);
    const reason = body.reason.trim();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug, { lock: true });
        if (org.status !== 'archived') {
          throw conflict(
            'deletion_not_archived',
            `Organisation ${org.slug} is ${org.status}: only an archived organisation has a deletion date`,
            `Organisasi ${org.slug} berstatus ${org.status}: hanya organisasi yang diarsipkan yang memiliki tanggal penghapusan`,
          );
        }
        if (body.confirmSlug !== org.slug) throw confirmationMismatch(org.slug, 'archived');
        const archived = (await archivedAt(trx, org.id)) ?? now;
        const earliest = addDaysTo(archived, lifecyclePeriods(this.config).minGraceDays);
        if (scheduledFor.getTime() < earliest.getTime()) {
          throw conflict(
            'deletion_too_soon',
            `The deletion of ${org.slug} cannot be earlier than ${earliest.toISOString()} (archived on ${localDate(archived, org.time_zone)} plus ${lifecyclePeriods(this.config).minGraceDays} days)`,
            `Penghapusan ${org.slug} tidak boleh lebih awal dari ${earliest.toISOString()} (diarsipkan pada ${localDate(archived, org.time_zone)} ditambah ${lifecyclePeriods(this.config).minGraceDays} hari)`,
          );
        }
        if (scheduledFor.getTime() < now.getTime()) {
          throw conflict(
            'deletion_too_soon',
            `The deletion date ${body.scheduledFor} of ${org.slug} is in the past; choose now or later`,
            `Tanggal penghapusan ${body.scheduledFor} untuk ${org.slug} sudah lewat; pilih sekarang atau sesudahnya`,
          );
        }
        const open = await openDeletion(trx, org.id, { lock: true });
        if (open && open.status !== 'scheduled') {
          throw conflict(
            'deletion_in_progress',
            `The deletion of ${org.slug} is ${open.status}; its date can no longer change${open.status === 'failed' ? ' (retry it instead)' : ''}`,
            `Penghapusan ${org.slug} berstatus ${open.status}; tanggalnya tidak dapat diubah lagi${open.status === 'failed' ? ' (coba lagi sebagai gantinya)' : ''}`,
          );
        }
        const emails = (await tenantAdminsOf(trx, org.id)).map((a) => a.email);
        let id: string;
        let before: string | null = null;
        if (open) {
          id = open.id;
          before = open.scheduled_for.toISOString();
          await trx
            .updateTable('platform.organization_deletion')
            .set({ scheduled_for: scheduledFor, scheduled_by: actor.userId, reason, notify_emails_sealed: await sealNotifyEmails(this.keys, id, emails) })
            .where('id', '=', id)
            .execute();
        } else {
          id = randomUUID();
          await trx
            .insertInto('platform.organization_deletion')
            .values({
              id,
              organization_id: org.id,
              status: 'scheduled',
              scheduled_for: scheduledFor,
              scheduled_by: actor.userId,
              reason,
              notify_emails_sealed: await sealNotifyEmails(this.keys, id, emails),
              final_export_id: (await latestFinalExport(trx, org.id))?.id ?? null,
            })
            .execute();
        }
        await this.audit.record(trx, {
          action: 'ops.deletion_scheduled',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'organization_deletion',
          entityId: id,
          entityCode: org.slug,
          before: before ? { scheduledFor: before } : undefined,
          after: { scheduledFor: scheduledFor.toISOString(), reason, earliestAllowed: earliest.toISOString(), tenantAdmins: emails.length },
        });
        return { org, id };
      },
      { scope: actor.scope, userId: actor.userId, requestId },
    );
    const day = localDate(scheduledFor, done.org.time_zone);
    return {
      ok: true,
      changed: [],
      message: [`The deletion of ${done.org.slug} is scheduled for ${day}.`, `Penghapusan ${done.org.slug} dijadwalkan pada ${day}.`],
      data: { id: done.id, status: 'scheduled', scheduledFor: scheduledFor.toISOString() },
    };
  }

  /** `POST /ops/organizations/{org}/deletion/cancel`: cancel a scheduled deletion (409 when none is scheduled). */
  async cancel(actor: OperatorActor, slug: string, reason: string): Promise<OrganizationDeletionResult> {
    this.assertMulti();
    const why = reason.trim();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug, { lock: true });
        const open = await openDeletion(trx, org.id, { lock: true });
        if (!open || open.status !== 'scheduled') {
          throw new ConflictError(`Organisation ${org.slug} has no scheduled deletion to cancel${open ? ` (it is ${open.status})` : ''}`, { messageKey: 'deletion_in_progress' });
        }
        await trx
          .updateTable('platform.organization_deletion')
          .set({ status: 'cancelled', reason: `Cancelled: ${why}`.slice(0, 1000), notify_emails_sealed: null })
          .where('id', '=', open.id)
          .execute();
        await this.audit.record(trx, {
          action: 'ops.deletion_cancelled',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'organization_deletion',
          entityId: open.id,
          entityCode: org.slug,
          before: { status: 'scheduled', scheduledFor: open.scheduled_for.toISOString() },
          after: { status: 'cancelled', reason: why },
        });
        return { org, row: open };
      },
      { scope: actor.scope, userId: actor.userId, requestId: currentRequestId() },
    );
    return {
      ok: true,
      changed: [],
      message: [
        `The deletion of ${done.org.slug} is cancelled. The organisation stays archived until a deletion is scheduled again.`,
        `Penghapusan ${done.org.slug} dibatalkan. Organisasi tetap diarsipkan sampai penghapusan dijadwalkan lagi.`,
      ],
      data: { id: done.row.id, status: 'cancelled', scheduledFor: done.row.scheduled_for.toISOString() },
    };
  }

  /** `POST /ops/organizations/{org}/deletion/retry`: a failed purge runs again from its failed step (409 otherwise). */
  async retry(actor: OperatorActor, slug: string, reason: string): Promise<OrganizationDeletionResult> {
    this.assertMulti();
    const why = reason.trim();
    const requestId = currentRequestId();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug, { lock: true });
        const open = await openDeletion(trx, org.id, { lock: true });
        if (!open || open.status !== 'failed') {
          throw new ConflictError(`The deletion of ${org.slug} has not failed${open ? ` (it is ${open.status})` : ''}; only a failed purge is retried`, {
            messageKey: 'deletion_in_progress',
          });
        }
        await trx.updateTable('platform.organization_deletion').set({ status: 'running', error: null }).where('id', '=', open.id).execute();
        await this.queue.send('org.purge', { orgId: null, ...(requestId ? { requestId } : {}), payload: { deletionId: open.id } }, { singletonKey: `purge:${open.id}`, retryLimit: 0 }, trx);
        await this.audit.record(trx, {
          action: 'ops.deletion_retried',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'organization_deletion',
          entityId: open.id,
          entityCode: org.slug,
          before: { status: 'failed', failedStep: open.failed_step },
          after: { status: 'running', reason: why },
        });
        return { org, row: open };
      },
      { scope: actor.scope, userId: actor.userId, requestId },
    );
    return {
      ok: true,
      changed: [],
      message: [
        `The purge of ${done.org.slug} runs again from the step ${done.row.failed_step ?? 'check'}.`,
        `Penghapusan ${done.org.slug} dijalankan lagi dari langkah ${done.row.failed_step ?? 'check'}.`,
      ],
      data: { id: done.row.id, status: 'running', scheduledFor: done.row.scheduled_for.toISOString() },
    };
  }

  /** `GET /ops/organizations/{org}/deletion/certificate`: the signed certificate (409 before the deletion completed). */
  async certificate(slug: string): Promise<CertificateFile> {
    this.assertMulti();
    return this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug);
        const row = await shownDeletion(trx, org.id);
        if (!row) throw new NotFoundError(`Organisation ${slug} has no deletion`);
        if (row.status !== 'completed' || !row.certificate || !row.certificate_signature || !row.certificate_key_id) {
          throw new ConflictError(`The deletion of ${org.slug} is ${row.status}; the certificate exists once it has completed`);
        }
        const certificate = row.certificate as DeletionCertificate;
        return {
          fileName: certificateFileName(certificate),
          text: certificateFileText(certificate, row.certificate_signature, row.certificate_key_id),
          certificateId: certificate.certificateId,
        };
      },
      { scope: 'operator' },
    );
  }

  /**
   * `tenant deletion run --org <slug>`: queues `org.purge` for a deletion that is due now (scheduled with a date that has
   * come, which moves it to running, or already running). Never starts a purge before its date (A.2). Returns the id.
   */
  async runDue(slug: string): Promise<{ deletionId: string; orgId: string }> {
    this.assertMulti();
    const requestId = currentRequestId();
    const now = this.clock.now();
    return this.scope.withPlatform(
      async (trx) => {
        const org = await this.org(trx, slug, { lock: true });
        const open = await openDeletion(trx, org.id, { lock: true });
        if (!open) throw new ConflictError(`Organisation ${org.slug} has no deletion`, { messageKey: 'deletion_not_archived' });
        if (open.status === 'completed' || open.status === 'failed') {
          throw new ConflictError(`The deletion of ${org.slug} is ${open.status}${open.status === 'failed' ? '; retry it from the operator console' : ''}`, {
            messageKey: 'deletion_in_progress',
          });
        }
        if (open.status === 'scheduled') {
          if (org.status !== 'archived') throw conflict('deletion_not_archived', `Organisation ${org.slug} is ${org.status}; only an archived organisation can be purged`, `Organisasi ${org.slug} berstatus ${org.status}; hanya organisasi yang diarsipkan yang dapat dihapus`);
          if (open.scheduled_for.getTime() > now.getTime()) {
            throw conflict(
              'deletion_too_soon',
              `The deletion of ${org.slug} is due on ${open.scheduled_for.toISOString()}; nobody starts a purge before its date (move the date first if the customer asked in writing)`,
              `Penghapusan ${org.slug} jatuh tempo pada ${open.scheduled_for.toISOString()}; tidak ada yang memulai penghapusan sebelum tanggalnya`,
            );
          }
          await trx.updateTable('platform.organization_deletion').set({ status: 'running' }).where('id', '=', open.id).execute();
        }
        await this.queue.send('org.purge', { orgId: null, ...(requestId ? { requestId } : {}), payload: { deletionId: open.id } }, { singletonKey: `purge:${open.id}`, retryLimit: 0 }, trx);
        return { deletionId: open.id, orgId: org.id };
      },
      { scope: 'cli', requestId },
    );
  }

  /** The deletion by id with its organisation (the command line waits on it). */
  async status(deletionId: string): Promise<{ status: string; failedStep: string | null; error: string | null } | null> {
    return this.scope.withPlatform(
      async (trx) => {
        const row = await deletionById(trx, deletionId);
        return row ? { status: row.status, failedStep: row.failed_step, error: row.error } : null;
      },
      { scope: 'cli' },
    );
  }

  /** The organisation of a slug (not marked deleted in the row); 404 otherwise. */
  private async org(trx: Trx, slug: string, options: { lock?: boolean } = {}): Promise<OrgRow> {
    let query = trx.selectFrom('platform.organization').select(['id', 'slug', 'name', 'status', 'time_zone']).where('slug', '=', slug).where('deleted_at', 'is', null);
    if (options.lock) query = query.forNoKeyUpdate();
    const org = await query.executeTakeFirst();
    if (!org) throw unknownOrganisation(slug);
    return org;
  }

  /** The view of a deletion row. */
  private async view(trx: Trx, org: OrgRow, row: DeletionRow): Promise<OrganizationDeletionView> {
    const archived = await archivedAt(trx, org.id);
    const scheduledBy = row.scheduled_by
      ? await trx.selectFrom('platform.app_user').select(['handle', 'display_name']).where('id', '=', row.scheduled_by).executeTakeFirst()
      : undefined;
    const report = reportOf(row.report);
    const started = row.started_at !== null || report.steps.some((s) => s.status !== 'pending');
    const steps: OrganizationDeletionStep[] = started
      ? [
          ...report.steps.map((s) => ({ step: s.step, status: s.status, at: s.at, detail: s.detail })),
          ...report.checks.map((c) => ({ step: `check: ${c.check}`.slice(0, 40), status: c.passed ? ('done' as const) : ('failed' as const), at: null, detail: c.detail })),
        ]
      : [];
    const certificate = row.certificate as Partial<DeletionCertificate> | null;
    return {
      id: row.id,
      status: row.status,
      scheduledFor: row.scheduled_for.toISOString(),
      scheduledBy: scheduledBy ? { handle: scheduledBy.handle, displayName: scheduledBy.display_name } : null,
      reason: row.reason,
      archivedAt: archived ? archived.toISOString() : null,
      earliestAllowed: archived ? addDaysTo(archived, lifecyclePeriods(this.config).minGraceDays).toISOString() : null,
      finalExportId: row.final_export_id,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      failedStep: row.failed_step,
      error: row.error,
      steps,
      vaultObjectsDeleted: row.vault_objects_deleted === null ? null : Number(row.vault_objects_deleted),
      certificateId: typeof certificate?.certificateId === 'string' ? certificate.certificateId : null,
    };
  }
}
