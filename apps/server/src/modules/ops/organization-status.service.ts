// Status changes of an organisation by the platform operator (Milestone 2 D.1 `ops.organizations.status`, J.4, J.8,
// K.6; M2-S09), also behind the command `tenant set-status`. Multi tenancy only (single tenancy answers 409 `conflict`
// with messageKey `single_tenancy`, J.6).
//
// The machine of J.8 (`organization.status` of packages/shared/src/machines.ts, route `ops.organizations.status`):
//   active      -> suspended, offboarding
//   suspended   -> active, offboarding
//   offboarding -> active, archived
//   archived is final until the purge of K.8.
// Any other move, the same status included, is 409 `transition-not-allowed` with messageKey
// `invalid_status_transition`. A reason is required (the schema); `offboarding` and `archived` also need `confirmSlug`
// equal to the slug, else 422 `business-rule` with messageKey `confirmation_mismatch`.
//
// One transaction in platform scope (M2-02 follow-up 9) holds the organisation row lock, the new status, the status
// event, the platform-chain audit entry `ops.organization_status_changed`, the revocation of every session whose current
// organisation is this one (for `suspended` and `archived`; people keep their other memberships, identity/
// org-sessions.ts) and the change notice `mscd_tenant_changed` (`publishTenantChange` of M2-S10), on which every api and
// worker process drops its cached organisation (tenancy/tenant-resolver.ts). After the commit this process drops its
// own entry at once, and the Tenant Admins of the organisation get the in-app notice and the email
// `organization_status_changed` with the new status, what it means and the reason (J.4). The email names no person.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { transitionsVia, type OrganizationStatus, type OrganizationStatusChange, type OrganizationStatusChangeResult } from '@mscd/shared';
import { sql } from 'kysely';
import { ProblemError, TransitionNotAllowedError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { AccountMailer } from '../identity/account-mailer';
import { organisationStatusTexts } from '../identity/mail-templates';
import { OrgSessions, revokeReasonOfStatus } from '../identity/org-sessions';
import { publishTenantChange } from '../license/tenant-change';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';
import { singleTenancyRefusal, unknownOrganisation, type OperatorActor } from './organizations.service';

/** The route whose rows of the J.8 machine the operator performs (the command line performs the same rows). */
const STATUS_ROUTE = 'ops.organizations.status';

/**
 * Until M3-03 builds the deletion of Milestone 3 (D.2, D.5), archived stays final on this route: the J.8 machine of
 * M3-01 adds `archived -> offboarding` (allowed only while a deletion is scheduled, which it cancels), and this
 * service keeps refusing it until that check exists. `deleted` is never a target (the request schema refuses it).
 */
const FINAL_UNTIL_DELETION: ReadonlySet<OrganizationStatus> = new Set(['archived', 'deleted']);

/** Moves that also need `confirmSlug` equal to the slug (J.8): they end the customer's use of the service. */
const CONFIRMED_STATUSES: ReadonlySet<OrganizationStatus> = new Set(['offboarding', 'archived']);

/** A Tenant Admin who is told about the change. */
interface TenantAdmin {
  id: string;
  email: string;
}

/** What a status change did; `result` is the answer of the route. */
export interface StatusChangeOutcome {
  result: OrganizationStatusChangeResult;
  orgId: string;
  eventId: string;
}

/** 409 `transition-not-allowed` with messageKey `invalid_status_transition` (J.6). */
export function invalidStatusTransition(slug: string, from: OrganizationStatus, to: OrganizationStatus): TransitionNotAllowedError {
  const allowed = allowedMoves(from);
  const en =
    from === to
      ? `Organisation ${slug} is already ${to}.`
      : `Organisation ${slug} is ${from} and cannot move to ${to}. ${allowed.length > 0 ? `From ${from} it can move to ${allowed.join(' or ')}.` : `${from} is final.`}`;
  const id =
    from === to
      ? `Organisasi ${slug} sudah berstatus ${to}.`
      : `Organisasi ${slug} berstatus ${from} dan tidak dapat dipindahkan ke ${to}. ${allowed.length > 0 ? `Dari ${from} organisasi dapat dipindahkan ke ${allowed.join(' atau ')}.` : `${from} adalah status akhir.`}`;
  return new TransitionNotAllowedError(from, to, { messageKey: 'invalid_status_transition', messages: { en, id } });
}

/** 422 `business-rule` with messageKey `confirmation_mismatch` (J.6): `confirmSlug` must repeat the slug. */
export function confirmationMismatch(slug: string, to: OrganizationStatus): ProblemError {
  const en = `Moving organisation ${slug} to ${to} needs confirmSlug equal to the slug ${slug}.`;
  const id = `Memindahkan organisasi ${slug} ke ${to} memerlukan confirmSlug yang sama dengan slug ${slug}.`;
  return new ProblemError('business-rule', { detail: en, messageKey: 'confirmation_mismatch', messages: { en, id } });
}

/** The statuses the operator may move an organisation to from `from` (J.8). */
export function allowedMoves(from: OrganizationStatus): OrganizationStatus[] {
  if (FINAL_UNTIL_DELETION.has(from)) return [];
  const targets: OrganizationStatus[] = ['active', 'suspended', 'offboarding', 'archived'];
  return targets.filter((to) => to !== from && transitionsVia('organization.status', from, to, STATUS_ROUTE).length > 0);
}

@Injectable()
export class OrganizationStatusService {
  private readonly logger = new Logger('OrganizationStatus');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly sessions: OrgSessions,
    private readonly mailer: AccountMailer,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `POST /ops/organizations/{org}/status`, and `tenant set-status` with `CLI_OPERATOR`. */
  async change(actor: OperatorActor, slug: string, body: OrganizationStatusChange): Promise<StatusChangeOutcome> {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
    const reason = body.reason.trim();
    const to = body.status;
    const done = await this.scope.withPlatform(
      async (trx) => {
        // The row lock orders two changes of one organisation; it lets foreign key checks of other rows through.
        const org = await trx
          .selectFrom('platform.organization')
          .select(['id', 'slug', 'name', 'schema_name', 'status'])
          .where('slug', '=', slug)
          .where('deleted_at', 'is', null)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!org) throw unknownOrganisation(slug);
        const from = org.status;
        if (from === to || FINAL_UNTIL_DELETION.has(from) || transitionsVia('organization.status', from, to, STATUS_ROUTE).length === 0) {
          throw invalidStatusTransition(org.slug, from, to);
        }
        if (CONFIRMED_STATUSES.has(to) && body.confirmSlug !== org.slug) throw confirmationMismatch(org.slug, to);

        await trx.updateTable('platform.organization').set({ status: to }).where('id', '=', org.id).execute();
        const event = await trx
          .insertInto('platform.organization_status_event')
          .values({ organization_id: org.id, from_status: from, to_status: to, reason, actor_user_id: actor.userId })
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
          after: { status: to, reason, eventId: event.id, sessionsRevoked, tenantAdmins: admins.length },
        });
        // Delivered when this transaction commits: every api and worker process drops the organisation it cached.
        await publishTenantChange(trx, org.id);
        return { org, from, eventId: event.id, sessionsRevoked, admins };
      },
      { scope: actor.scope, userId: actor.userId, requestId: currentRequestId() },
    );
    // This process at once (the notice also reaches it, a moment later).
    this.tenants.invalidate(done.org.id);

    const notified = await this.notifyTenantAdmins(done.org, to, reason, done.admins, actor);
    const fromLabel = done.from;
    const sessionsText: [string, string] =
      done.sessionsRevoked > 0
        ? [` ${done.sessionsRevoked} ${done.sessionsRevoked === 1 ? 'session was' : 'sessions were'} ended.`, ` ${done.sessionsRevoked} sesi diakhiri.`]
        : ['', ''];
    const adminsText: [string, string] =
      done.admins.length === 0
        ? [' The organisation has no active Tenant Admin to tell.', ' Organisasi ini tidak memiliki Tenant Admin aktif untuk diberi tahu.']
        : [
            ` ${notified} of ${done.admins.length} Tenant ${done.admins.length === 1 ? 'Admin was' : 'Admins were'} emailed.`,
            ` ${notified} dari ${done.admins.length} Tenant Admin dikirimi email.`,
          ];
    return {
      orgId: done.org.id,
      eventId: done.eventId,
      result: {
        ok: true,
        changed: [],
        message: [
          `Organisation ${done.org.slug} moved from ${fromLabel} to ${to}.${sessionsText[0]}${adminsText[0]}`,
          `Organisasi ${done.org.slug} dipindahkan dari ${fromLabel} ke ${to}.${sessionsText[1]}${adminsText[1]}`,
        ],
        data: {
          slug: done.org.slug,
          from: done.from,
          to,
          sessionsRevoked: done.sessionsRevoked,
          tenantAdmins: done.admins.length,
          tenantAdminsEmailed: notified,
        },
      },
    };
  }

  /**
   * The notice `organization_status_changed` (J.4) to every active Tenant Admin: the in-app notification in the
   * organisation (written with `email_status` `skipped`, because the email goes out here: `notifications.dispatch`
   * emails only active and offboarding organisations) and the email. Returns how many emails were sent. The change is
   * committed, so a failure here is logged and never undoes it.
   */
  private async notifyTenantAdmins(
    org: { id: string; slug: string; name: string; schema_name: string },
    status: OrganizationStatusChange['status'],
    reason: string,
    admins: readonly TenantAdmin[],
    actor: OperatorActor,
  ): Promise<number> {
    if (admins.length === 0) return 0;
    const en = organisationStatusTexts(status, org.name, 'en');
    const id = organisationStatusTexts(status, org.name, 'id');
    const createdBy = actor.userId ?? SYSTEM_USER_ID;
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
              body_en: `${en.meaning} Reason given by your MSCD service provider: ${reason}`,
              body_id: `${id.meaning} Alasan yang diberikan penyedia layanan MSCD Anda: ${reason}`,
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
          template: { name: 'organization_status_changed', link: this.mailer.appLink('/'), organisation: org.name, status, reason },
        }),
      ),
    );
    const sent = results.filter(Boolean).length;
    if (sent < admins.length) this.logger.warn({ orgId: org.id }, `${admins.length - sent} of ${admins.length} status emails could not be sent`);
    return sent;
  }
}

/** Active Tenant Admins of an organisation (active person accounts with an active membership holding `tenant_admin`). */
async function tenantAdminsOf(trx: Trx, orgId: string): Promise<TenantAdmin[]> {
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
