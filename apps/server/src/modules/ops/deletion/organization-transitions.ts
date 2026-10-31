// Status moves of an organisation (Milestone 2 D.1 `ops.organizations.status`, J.4, J.8, K.6; M2-S09) with the end of
// contract of Milestone 3 (D.2, D.5, J.8; M3-03). Multi tenancy only (single tenancy answers 409 `conflict` with
// messageKey `single_tenancy`, J.6). `OrganizationStatusService` (the route and `tenant set-status`) and `org.lifecycle`
// both move organisations through this class, which lives in the deletion sub-module so the lifecycle job can use it.
//
// The machine of J.8 (`organization.status` of packages/shared/src/machines.ts):
//   active      -> suspended, offboarding                     (operator)
//   suspended   -> active, offboarding                        (operator)
//   offboarding -> active, archived                           (operator; archived also by the system at the end of the
//                                                              read-only period, org.lifecycle)
//   archived    -> offboarding                                (operator, only while the deletion is scheduled, which it
//                                                              cancels; read-only again for 7 days)
//   archived    -> deleted                                    (the system: org.purge; never a caller)
//   active, suspended, offboarding -> archived                (the system: tenant purge --reapply after a restore)
// Any other move, the same status included, is 409 `transition-not-allowed` with messageKey `invalid_status_transition`.
// A reason is required (the schema); `offboarding` and `archived` also need `confirmSlug` equal to the slug, else 422
// `business-rule` with messageKey `confirmation_mismatch`.
//
// What a move does besides the status, in one transaction in platform scope with the organisation row locked:
//   - offboarding: `offboarding_ends_at` = now plus `lifecycle.offboarding_days` (7 days when reopened from archived,
//     which also cancels the scheduled deletion), and the final export queued (D.4);
//   - archived: the end of the read-only period cleared, every session of the organisation ended, the deletion scheduled
//     for now plus `lifecycle.deletion_grace_days` with the Tenant Admins' addresses sealed for the certificate (D.5.5);
//   - active, suspended: the end of the read-only period cleared; suspended ends the sessions too;
// then the status event, the platform-chain audit entry (`ops.organization_status_changed`, or `tenant.offboarding_ended`
// for the system's move), and the change notice `mscd_tenant_changed` on which every api and worker process drops its
// cached organisation. After the commit the Tenant Admins get the in-app notice and the email
// `organization_status_changed` with the new status, what it means, the end of the read-only period or the deletion
// date, and the reason (J.4). The email names no person.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { transitionsVia, type OrganizationStatus, type OrganizationStatusChange, type OrganizationStatusChangeResult } from '@mscd/shared';
import { Clock } from '../../../common/clock';
import { localDate } from '../../../common/dates';
import { JOB_QUEUE, type JobQueue } from '../../../common/jobs/job-queue';
import { ProblemError, TransitionNotAllowedError } from '../../../common/problems';
import { currentRequestId } from '../../../common/request-context';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter, type Trx } from '../../../common/tokens';
import { MscdConfig } from '../../../config/mscd-config';
import { AccountMailer } from '../../identity/account-mailer';
import { organisationStatusTexts, type OrganisationStatusName } from '../../identity/mail-templates';
import { OrgSessions, revokeReasonOfStatus } from '../../identity/org-sessions';
import type { FileKeyProvider } from '../../keys/file-key-provider';
import { PLATFORM_KEY_PROVIDER } from '../../keys/secret-box';
import { publishTenantChange } from '../../license/tenant-change';
import { TenantResolver } from '../../tenancy/tenant-resolver';
import { TenantScope } from '../../tenancy/tenant-scope';
import { singleTenancyRefusal, unknownOrganisation, type OperatorActor } from '../organizations.service';
import {
  REOPEN_DAYS,
  addDaysTo,
  emptyReport,
  latestFinalExport,
  lifecyclePeriods,
  openDeletion,
  queueFinalExport,
  sealNotifyEmails,
  tenantAdminsOf,
  type DeletionRow,
  type PurgeReport,
  type TenantAdmin,
} from './deletion-records';

/** The route whose rows of the J.8 machine the operator performs (the command line performs the same rows). */
const STATUS_ROUTE = 'ops.organizations.status';

/** Moves that also need `confirmSlug` equal to the slug (J.8): they end the customer's use of the service. */
const CONFIRMED_STATUSES: ReadonlySet<OrganizationStatus> = new Set(['offboarding', 'archived']);

/** What the operator's move needs to know about the organisation besides its status (J.8). */
export interface MoveContext {
  /** True while the deletion of the organisation is `scheduled` (the only time archived may return to offboarding). */
  deletionScheduled: boolean;
}

/** The statuses the operator may move an organisation to from `from` (J.8). */
export function allowedMoves(from: OrganizationStatus, context: MoveContext = { deletionScheduled: false }): OrganizationStatus[] {
  if (from === 'deleted') return [];
  if (from === 'archived') return context.deletionScheduled ? ['offboarding'] : [];
  const targets: OrganizationStatus[] = ['active', 'suspended', 'offboarding', 'archived'];
  return targets.filter((to) => to !== from && transitionsVia('organization.status', from, to, STATUS_ROUTE).length > 0);
}

/** 409 `transition-not-allowed` with messageKey `invalid_status_transition` (J.6). */
export function invalidStatusTransition(
  slug: string,
  from: OrganizationStatus,
  to: OrganizationStatus,
  context: MoveContext = { deletionScheduled: false },
): TransitionNotAllowedError {
  const allowed = allowedMoves(from, context);
  const final =
    from === 'archived'
      ? [
          'archived is final. It can move back to offboarding only while its deletion is scheduled.',
          'archived adalah status akhir. Status ini hanya dapat kembali ke offboarding selama penghapusannya dijadwalkan.',
        ]
      : [`${from} is final.`, `${from} adalah status akhir.`];
  const en =
    from === to
      ? `Organisation ${slug} is already ${to}.`
      : `Organisation ${slug} is ${from} and cannot move to ${to}. ${allowed.length > 0 ? `From ${from} it can move to ${allowed.join(' or ')}.` : final[0]}`;
  const id =
    from === to
      ? `Organisasi ${slug} sudah berstatus ${to}.`
      : `Organisasi ${slug} berstatus ${from} dan tidak dapat dipindahkan ke ${to}. ${allowed.length > 0 ? `Dari ${from} organisasi dapat dipindahkan ke ${allowed.join(' atau ')}.` : final[1]}`;
  return new TransitionNotAllowedError(from, to, { messageKey: 'invalid_status_transition', messages: { en, id } });
}

/** 422 `business-rule` with messageKey `confirmation_mismatch` (J.6): `confirmSlug` must repeat the slug. */
export function confirmationMismatch(slug: string, to: OrganizationStatus): ProblemError {
  const en = `Moving organisation ${slug} to ${to} needs confirmSlug equal to the slug ${slug}.`;
  const id = `Memindahkan organisasi ${slug} ke ${to} memerlukan confirmSlug yang sama dengan slug ${slug}.`;
  return new ProblemError('business-rule', { detail: en, messageKey: 'confirmation_mismatch', messages: { en, id } });
}

/** What a status change did; `result` is the answer of the route. */
export interface StatusChangeOutcome {
  result: OrganizationStatusChangeResult;
  orgId: string;
  eventId: string;
}

/** The organisation row a move locks. */
interface LockedOrganization {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  status: OrganizationStatus;
  time_zone: string;
  offboarding_ends_at: Date | null;
}

/** The effects of a move besides the status. */
interface MoveEffects {
  offboardingEndsAt: Date | null;
  deletion: { id: string; scheduledFor: Date } | null;
  cancelledDeletionId: string | null;
  finalExportId: string | null;
}

/** What a committed move tells the Tenant Admins. */
interface Committed {
  org: LockedOrganization;
  from: OrganizationStatus;
  to: Exclude<OrganizationStatus, 'deleted'>;
  eventId: string;
  sessionsRevoked: number;
  admins: TenantAdmin[];
  effects: MoveEffects;
}

@Injectable()
export class OrganizationTransitions {
  private readonly logger = new Logger('OrganizationStatus');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly sessions: OrgSessions,
    private readonly mailer: AccountMailer,
    private readonly clock: Clock,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(PLATFORM_KEY_PROVIDER) private readonly keys: FileKeyProvider,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `POST /ops/organizations/{org}/status`, and `tenant set-status` with `CLI_OPERATOR`. */
  async operatorMove(actor: OperatorActor, slug: string, body: OrganizationStatusChange): Promise<StatusChangeOutcome> {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
    const reason = body.reason.trim();
    const to = body.status;
    const requestId = currentRequestId();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.lock(trx, { slug });
        if (!org) throw unknownOrganisation(slug);
        const from = org.status;
        const deletion = await openDeletion(trx, org.id, { lock: true });
        const context: MoveContext = { deletionScheduled: deletion?.status === 'scheduled' };
        if (!allowedMoves(from, context).includes(to)) throw invalidStatusTransition(org.slug, from, to, context);
        if (CONFIRMED_STATUSES.has(to) && body.confirmSlug !== org.slug) throw confirmationMismatch(org.slug, to);

        const effects = await this.apply(trx, org, from, to, reason, deletion, requestId);
        const event = await trx
          .insertInto('platform.organization_status_event')
          .values({ organization_id: org.id, from_status: from, to_status: to, reason, actor_user_id: actor.userId, created_at: this.clock.now() })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        const revokeReason = revokeReasonOfStatus(to);
        const sessionsRevoked = revokeReason ? await this.sessions.revokeCurrentOrganisation(trx, org.id, revokeReason) : 0;
        const admins = await tenantAdminsOf(trx, org.id);
        await this.audit.record(trx, {
          action: 'ops.organization_status_changed',
          actor: { userId: actor.userId, kind: 'operator' },
          organizationId: org.id,
          entityType: 'organization',
          entityId: org.id,
          entityCode: org.slug,
          before: { status: from },
          after: { status: to, reason, eventId: event.id, sessionsRevoked, tenantAdmins: admins.length, ...effectsAudit(effects) },
        });
        // Delivered when this transaction commits: every api and worker process drops the organisation it cached.
        await publishTenantChange(trx, org.id);
        return { org, from, to, eventId: event.id, sessionsRevoked, admins, effects } satisfies Committed;
      },
      { scope: actor.scope, userId: actor.userId, requestId },
    );
    // This process at once (the notice also reaches it, a moment later).
    this.tenants.invalidate(done.org.id);
    const notified = await this.notifyTenantAdmins(done, reason, actor.userId);
    return { orgId: done.org.id, eventId: done.eventId, result: this.resultOf(done, notified) };
  }

  /**
   * `org.lifecycle` (D.5.1): moves an organisation whose read-only period has ended from offboarding to archived as the
   * system (no actor), schedules its deletion and tells the Tenant Admins. Returns false (and changes nothing) when the
   * organisation is not offboarding or its period has not ended (a move of the operator in between).
   */
  async endReadOnlyPeriod(orgId: string, requestId?: string): Promise<boolean> {
    if (this.config.profile.tenancy.mode !== 'multi') return false;
    const now = this.clock.now();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.lock(trx, { id: orgId });
        if (!org || org.status !== 'offboarding' || !org.offboarding_ends_at || org.offboarding_ends_at.getTime() > now.getTime()) return null;
        const reason = `The read-only period ended on ${localDate(org.offboarding_ends_at, org.time_zone)}`;
        const deletion = await openDeletion(trx, org.id, { lock: true });
        const effects = await this.apply(trx, org, 'offboarding', 'archived', reason, deletion, requestId);
        const event = await trx
          .insertInto('platform.organization_status_event')
          .values({ organization_id: org.id, from_status: 'offboarding', to_status: 'archived', reason, actor_user_id: null, created_at: now })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        const sessionsRevoked = await this.sessions.revokeCurrentOrganisation(trx, org.id, 'organisation_archived');
        const admins = await tenantAdminsOf(trx, org.id);
        await this.audit.record(trx, {
          action: 'tenant.offboarding_ended',
          actor: { userId: SYSTEM_USER_ID, kind: 'system' },
          organizationId: org.id,
          entityType: 'organization',
          entityId: org.id,
          entityCode: org.slug,
          before: { status: 'offboarding', offboardingEndsAt: org.offboarding_ends_at.toISOString() },
          after: { status: 'archived', reason, eventId: event.id, sessionsRevoked, tenantAdmins: admins.length, ...effectsAudit(effects) },
          sourceIp: null,
          userAgent: null,
        });
        await publishTenantChange(trx, org.id);
        return { org, from: 'offboarding', to: 'archived', eventId: event.id, sessionsRevoked, admins, effects, reason } as Committed & { reason: string };
      },
      { scope: 'job', requestId },
    );
    if (!done) return false;
    this.tenants.invalidate(done.org.id);
    await this.notifyTenantAdmins(done, done.reason, null);
    return true;
  }

  /**
   * `tenant purge --reapply` (D.5.6, J.8 re-apply rows): after a restore from a backup older than a certified deletion,
   * moves the organisation to archived as the system (from active, suspended or offboarding) and its deletion to
   * `running` with `scheduled_for` now, then queues `org.purge` for the worker, all in one transaction. The caller has
   * checked the certificate (signature and organisation id). Returns the deletion id, or null when the organisation is
   * deleted already.
   */
  async reapplyDeletion(orgId: string, certificate: { certificateId: string; deletionId: string }, requestId?: string): Promise<{ deletionId: string; from: OrganizationStatus } | null> {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
    const now = this.clock.now();
    const done = await this.scope.withPlatform(
      async (trx) => {
        const org = await this.lock(trx, { id: orgId });
        if (!org) throw unknownOrganisation(orgId);
        if (org.status === 'deleted') return null;
        const from = org.status;
        const reason = `Deletion re-applied after a restore (certificate ${certificate.certificateId})`;
        if (from !== 'archived') {
          await trx.updateTable('platform.organization').set({ status: 'archived', offboarding_ends_at: null }).where('id', '=', org.id).execute();
          await trx
            .insertInto('platform.organization_status_event')
            .values({ organization_id: org.id, from_status: from, to_status: 'archived', reason, actor_user_id: null, created_at: now })
            .execute();
          await this.sessions.revokeCurrentOrganisation(trx, org.id, 'organisation_archived');
        }
        const existing = await openDeletion(trx, org.id, { lock: true });
        let deletionId: string;
        const reapplied = { certificateId: certificate.certificateId, originalDeletionId: certificate.deletionId, at: now.toISOString() };
        if (existing && (existing.status === 'scheduled' || existing.status === 'failed' || existing.status === 'running')) {
          deletionId = existing.id;
          // Every step runs again: a report restored with a failed or running purge would skip the steps it marks done,
          // and the restored vault and schema need them all (D.5.6). The steps are idempotent.
          const report: PurgeReport = { ...emptyReport(), reapplied };
          await trx
            .updateTable('platform.organization_deletion')
            .set({ status: 'running', scheduled_for: now, reason, started_at: null, failed_step: null, error: null, vault_objects_deleted: null, report: JSON.stringify(report) })
            .where('id', '=', existing.id)
            .execute();
        } else if (existing) {
          // A completed deletion of an organisation that is not deleted cannot come from a backup; leave it to the operator.
          throw new ProblemError('conflict', {
            detail: `Organisation ${org.slug} has a completed deletion but is ${from}; check it with "tenant deletion show" before re-applying`,
            messageKey: 'deletion_in_progress',
          });
        } else {
          deletionId = randomUUID();
          const emails = (await tenantAdminsOf(trx, org.id)).map((a) => a.email);
          await trx
            .insertInto('platform.organization_deletion')
            .values({
              id: deletionId,
              organization_id: org.id,
              status: 'running',
              scheduled_for: now,
              scheduled_by: null,
              reason,
              notify_emails_sealed: await sealNotifyEmails(this.keys, deletionId, emails),
              final_export_id: (await latestFinalExport(trx, org.id))?.id ?? null,
              report: JSON.stringify({ ...emptyReport(), reapplied } satisfies PurgeReport),
            })
            .execute();
        }
        await this.audit.record(trx, {
          action: 'ops.organization_status_changed',
          actor: { userId: null, kind: 'operator' },
          organizationId: org.id,
          entityType: 'organization',
          entityId: org.id,
          entityCode: org.slug,
          before: { status: from },
          after: { status: 'archived', reason, reapplied: { ...reapplied, deletionId } },
        });
        await this.queue.send('org.purge', { orgId: null, ...(requestId ? { requestId } : {}), payload: { deletionId } }, { singletonKey: `purge:${deletionId}`, retryLimit: 0 }, trx);
        await publishTenantChange(trx, org.id);
        return { deletionId, from };
      },
      { scope: 'cli', requestId },
    );
    this.tenants.invalidate(orgId);
    return done;
  }

  /** Locks the organisation row (by slug or id) for a move; null when there is none. */
  private async lock(trx: Trx, by: { slug: string } | { id: string }): Promise<LockedOrganization | null> {
    // The row lock orders two changes of one organisation; it lets foreign key checks of other rows through.
    let query = trx
      .selectFrom('platform.organization')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'time_zone', 'offboarding_ends_at'])
      .where('deleted_at', 'is', null);
    query = 'slug' in by ? query.where('slug', '=', by.slug) : query.where('id', '=', by.id);
    return (await query.forNoKeyUpdate().executeTakeFirst()) ?? null;
  }

  /** The status and the effects of a move (D.2, D.5.1), in the move's transaction. */
  private async apply(
    trx: Trx,
    org: LockedOrganization,
    from: OrganizationStatus,
    to: Exclude<OrganizationStatus, 'deleted'>,
    reason: string,
    deletion: DeletionRow | null,
    requestId: string | undefined,
  ): Promise<MoveEffects> {
    const now = this.clock.now();
    const periods = lifecyclePeriods(this.config);
    const effects: MoveEffects = { offboardingEndsAt: null, deletion: null, cancelledDeletionId: null, finalExportId: null };
    if (to === 'offboarding') {
      const reopened = from === 'archived';
      effects.offboardingEndsAt = addDaysTo(now, reopened ? REOPEN_DAYS : periods.offboardingDays);
      await trx.updateTable('platform.organization').set({ status: to, offboarding_ends_at: effects.offboardingEndsAt }).where('id', '=', org.id).execute();
      if (reopened && deletion?.status === 'scheduled') {
        await trx
          .updateTable('platform.organization_deletion')
          .set({ status: 'cancelled', reason: `Reopened for an export: ${reason}`.slice(0, 1000) })
          .where('id', '=', deletion.id)
          .execute();
        effects.cancelledDeletionId = deletion.id;
      }
      effects.finalExportId = await queueFinalExport(trx, this.queue, org.id, requestId);
      return effects;
    }
    await trx.updateTable('platform.organization').set({ status: to, offboarding_ends_at: null }).where('id', '=', org.id).execute();
    if (to === 'archived') {
      if (deletion && deletion.status === 'scheduled') {
        effects.deletion = { id: deletion.id, scheduledFor: deletion.scheduled_for };
      } else if (!deletion) {
        const id = randomUUID();
        const scheduledFor = addDaysTo(now, periods.graceDays);
        const emails = (await tenantAdminsOf(trx, org.id)).map((a) => a.email);
        await trx
          .insertInto('platform.organization_deletion')
          .values({
            id,
            organization_id: org.id,
            status: 'scheduled',
            scheduled_for: scheduledFor,
            scheduled_by: null,
            reason,
            notify_emails_sealed: await sealNotifyEmails(this.keys, id, emails),
            final_export_id: (await latestFinalExport(trx, org.id))?.id ?? null,
          })
          .execute();
        effects.deletion = { id, scheduledFor };
      }
    }
    return effects;
  }

  /** The answer of the route. */
  private resultOf(done: Committed, notified: number): OrganizationStatusChangeResult {
    const sessionsText: [string, string] =
      done.sessionsRevoked > 0
        ? [` ${done.sessionsRevoked} ${done.sessionsRevoked === 1 ? 'session was' : 'sessions were'} ended.`, ` ${done.sessionsRevoked} sesi diakhiri.`]
        : ['', ''];
    const tz = done.org.time_zone;
    const datesText: [string, string] = done.effects.offboardingEndsAt
      ? [
          ` The read-only period ends on ${localDate(done.effects.offboardingEndsAt, tz)} and the final export was queued.`,
          ` Masa hanya-baca berakhir pada ${localDate(done.effects.offboardingEndsAt, tz)} dan ekspor akhir telah diantrekan.`,
        ]
      : done.effects.deletion
        ? [
            ` The deletion is scheduled for ${localDate(done.effects.deletion.scheduledFor, tz)}.`,
            ` Penghapusan dijadwalkan pada ${localDate(done.effects.deletion.scheduledFor, tz)}.`,
          ]
        : ['', ''];
    const cancelledText: [string, string] = done.effects.cancelledDeletionId
      ? [' The scheduled deletion was cancelled.', ' Penghapusan yang dijadwalkan dibatalkan.']
      : ['', ''];
    const adminsText: [string, string] =
      done.admins.length === 0
        ? [' The organisation has no active Tenant Admin to tell.', ' Organisasi ini tidak memiliki Tenant Admin aktif untuk diberi tahu.']
        : [
            ` ${notified} of ${done.admins.length} Tenant ${done.admins.length === 1 ? 'Admin was' : 'Admins were'} emailed.`,
            ` ${notified} dari ${done.admins.length} Tenant Admin dikirimi email.`,
          ];
    return {
      ok: true,
      changed: [],
      message: [
        `Organisation ${done.org.slug} moved from ${done.from} to ${done.to}.${sessionsText[0]}${datesText[0]}${cancelledText[0]}${adminsText[0]}`,
        `Organisasi ${done.org.slug} dipindahkan dari ${done.from} ke ${done.to}.${sessionsText[1]}${datesText[1]}${cancelledText[1]}${adminsText[1]}`,
      ],
      data: {
        slug: done.org.slug,
        from: done.from,
        to: done.to,
        sessionsRevoked: done.sessionsRevoked,
        tenantAdmins: done.admins.length,
        tenantAdminsEmailed: notified,
      },
    };
  }

  /**
   * The notice `organization_status_changed` (J.4) to every active Tenant Admin: the in-app notification in the
   * organisation (written with `email_status` `skipped`, because the email goes out here: `notifications.dispatch`
   * emails only active and offboarding organisations) and the email. Returns how many emails were sent. The change is
   * committed, so a failure here is logged and never undoes it.
   */
  private async notifyTenantAdmins(done: Committed, reason: string, actorUserId: string | null): Promise<number> {
    const { org, admins, to } = done;
    if (admins.length === 0) return 0;
    const status = to as OrganisationStatusName;
    const readOnlyUntil = done.effects.offboardingEndsAt ? localDate(done.effects.offboardingEndsAt, org.time_zone) : null;
    const deletionOn = done.effects.deletion ? localDate(done.effects.deletion.scheduledFor, org.time_zone) : null;
    const en = organisationStatusTexts(status, org.name, 'en');
    const id = organisationStatusTexts(status, org.name, 'id');
    const extraEn = readOnlyUntil ? ` The read-only period ends on ${readOnlyUntil}.` : deletionOn ? ` MSCD deletes the data on ${deletionOn}.` : '';
    const extraId = readOnlyUntil ? ` Masa hanya-baca berakhir pada ${readOnlyUntil}.` : deletionOn ? ` MSCD menghapus data pada ${deletionOn}.` : '';
    const createdBy = actorUserId ?? SYSTEM_USER_ID;
    try {
      await this.scope.withTenant({ orgId: org.id, schema: org.schema_name, userId: createdBy }, async (trx) => {
        for (const admin of admins) {
          await trx
            .insertInto('notification')
            .values({
              recipient_user_id: admin.id,
              management_system_id: null,
              kind: 'organization_status_changed',
              title_en: en.title,
              title_id: id.title,
              body_en: `${en.meaning}${extraEn} Reason given by your MSCD service provider: ${reason}`,
              body_id: `${id.meaning}${extraId} Alasan yang diberikan penyedia layanan MSCD Anda: ${reason}`,
              entity_ref: null,
              digest: false,
              email_status: 'skipped',
              created_by: createdBy,
              updated_by: createdBy,
            })
            .execute();
        }
      });
    } catch (error) {
      this.logger.error({ orgId: org.id }, `Could not write the organization_status_changed notices: ${error instanceof Error ? error.message : String(error)}`);
    }
    // One message per admin, sent side by side, so a slow mail server delays the answer once (AccountMailer.send
    // never throws; it answers false for a message it could not send).
    const results = await Promise.all(
      admins.map((admin) =>
        this.mailer.send({
          to: { email: admin.email, userId: admin.id },
          template: {
            name: 'organization_status_changed',
            link: this.mailer.appLink('/'),
            organisation: org.name,
            status,
            reason,
            readOnlyUntil,
            deletionOn,
          },
        }),
      ),
    );
    const sent = results.filter(Boolean).length;
    if (sent < admins.length) this.logger.warn({ orgId: org.id }, `${admins.length - sent} of ${admins.length} status emails could not be sent`);
    return sent;
  }
}

/** The effects of a move as the audit entry records them. */
function effectsAudit(effects: MoveEffects): Record<string, unknown> {
  return {
    ...(effects.offboardingEndsAt ? { offboardingEndsAt: effects.offboardingEndsAt.toISOString() } : {}),
    ...(effects.finalExportId ? { finalExportId: effects.finalExportId } : {}),
    ...(effects.deletion ? { deletion: { id: effects.deletion.id, scheduledFor: effects.deletion.scheduledFor.toISOString() } } : {}),
    ...(effects.cancelledDeletionId ? { cancelledDeletionId: effects.cancelledDeletionId } : {}),
  };
}
