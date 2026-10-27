// Organisations of the platform operator (Milestone 2 D.1, D.2, M2-06), multi tenancy only (single tenancy answers
// 409 `conflict` with messageKey `single_tenancy`, H.12):
// - `GET /ops/organizations`: every organisation that is not deleted, with status, licence state, plan and validity
//   of the entitlement row, active members (guests not counted), systems that are not archived, verified email
//   domains and the creation time; search by slug or name and a status filter, paged.
// - `POST /ops/organizations`: creates the organisation with `TenantProvisioner.create` (schema, tenant migrations,
//   data key from the storage gateway, Managed Vault repository, `tenant.created`), with local sign-in allowed
//   (product decision 7 of CLAUDE.md), and invites its first administrator as Tenant Admin. The invitation is emailed;
//   with `mail.required` (SaaS) nothing is created while SMTP does not work (409 `mail_required`) and the link is never
//   returned; without it and with mail off, the response carries the one-time link once. An existing active account
//   gets an invited membership, the email and the notification `membership_invited` instead of a link. Audited
//   `ops.organization_created`. The `preset` of `license.plans` is checked here and applied by M2-S09 (D.2).
// Writes to platform tables run in platform scope (M2-02 follow-up 9); the organisation's own schema is written by the
// provisioner as its owner.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OpsOrganizationCreate, OpsOrganizationCreateResult, OpsOrganizationItem, OpsOrganizationListQuery, Page } from '@mscd/shared';
import { sql } from 'kysely';
import { ConflictError, DependencyUnavailableError, ProblemError, ValidationError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { ConfigError, MscdConfig } from '../../config/mscd-config';
import { TenantProvisioner, TenantProvisioningError, type CreatedTenant } from '../../db/tenant-provisioner';
import { canonicalTimeZone } from '../admin-users/time-zone';
import { AccountMailer } from '../identity/account-mailer';
import { INVITATION_TTL_MS, InvitationService, type InvitedUser } from '../identity/invitation.service';
import { LicenceService } from '../license/licence.service';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { checkMailReadiness, mailRequiredMessage } from './mail-readiness';
import { TenantDataKeys } from './tenant-data-keys';

interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  status: OpsOrganizationItem['status'];
  created_at: Date;
  member_count: string;
  plan: string | null;
  valid_until: string | null;
  verified_domains: string[] | null;
}

/** 409 `conflict` with messageKey `single_tenancy` (J.6). */
export function singleTenancyRefusal(): ConflictError {
  return new ConflictError('This installation runs one organisation (tenancy.mode single); organisations are created with the installer', {
    messageKey: 'single_tenancy',
  });
}

function rule(detail: string, messageKey: string, id: string): ProblemError {
  return new ProblemError('business-rule', { detail, messageKey, messages: { en: detail, id } });
}

@Injectable()
export class OpsOrganizationsService {
  private readonly logger = new Logger('OpsOrganizations');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly licences: LicenceService,
    private readonly invitations: InvitationService,
    private readonly mailer: AccountMailer,
    private readonly dataKeys: TenantDataKeys,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private assertMultiTenancy(): void {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
  }

  /** `GET /ops/organizations`. */
  async list(query: OpsOrganizationListQuery): Promise<Page<OpsOrganizationItem>> {
    this.assertMultiTenancy();
    const search = query.q ? `%${query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = sql`o.deleted_at is null
      ${query.status ? sql`and o.status = ${query.status}` : sql``}
      ${search ? sql`and (lower(o.slug) like ${search} or lower(o.name) like ${search})` : sql``}`;
    const { total, rows } = await this.scope.withPlatform(
      async (trx) => {
        const counted = await sql<{ n: string }>`select count(*) as n from platform.organization o where ${where}`.execute(trx);
        const listed = await sql<OrganizationRow>`
          select o.id, o.slug, o.name, o.schema_name, o.status, o.created_at,
                 (select count(*) from platform.org_membership m join platform.app_user u on u.id = m.user_id
                   where m.organization_id = o.id and m.status = 'active' and m.deleted_at is null
                     and u.kind = 'person' and u.status = 'active' and u.deleted_at is null) as member_count,
                 e.plan, e.valid_until::text as valid_until,
                 (select array_agg(d.domain order by d.domain) from platform.verified_domain d
                   where d.organization_id = o.id and d.status = 'verified') as verified_domains
            from platform.organization o
            left join platform.entitlement e on e.organization_id = o.id
           where ${where}
           order by o.position, o.slug
           limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(trx);
        return { total: Number(counted.rows[0]?.n ?? 0), rows: listed.rows };
      },
      { scope: 'operator' },
    );
    const items: OpsOrganizationItem[] = [];
    for (const row of rows) {
      const tenant = { id: row.id, schema: row.schema_name };
      const { systems, licence } = await this.scope.withTenant(systemContextOf(tenant), async (trx) => {
        const counted = await sql<{ n: string }>`select count(*) as n from management_system where deleted_at is null and status <> 'archived'`.execute(trx);
        const evaluated = await this.licences.evaluate(trx, row.id, { reportRollback: false });
        return {
          systems: Number(counted.rows[0]?.n ?? 0),
          licence: evaluated?.document ? { state: evaluated.state, validUntil: evaluated.document.valid_until } : null,
        };
      });
      items.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        licence,
        memberCount: Number(row.member_count),
        systemCount: systems,
        plan: row.plan,
        validUntil: row.valid_until,
        verifiedDomains: row.verified_domains ?? [],
        createdAt: new Date(row.created_at).toISOString(),
      });
    }
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  /** `POST /ops/organizations`. */
  async create(principal: Principal, body: OpsOrganizationCreate): Promise<OpsOrganizationCreateResult> {
    this.assertMultiTenancy();
    const timeZone = canonicalTimeZone(body.timeZone);
    if (!timeZone) throw new ValidationError([{ path: 'body.timeZone', message: `Unknown time zone ${JSON.stringify(body.timeZone)}; use an IANA name such as Asia/Jakarta` }]);
    if (body.preset !== undefined && !Object.hasOwn(this.config.profile.license.plans, body.preset)) {
      throw rule(`There is no plan preset ${body.preset} in license.plans`, 'unknown_preset', `Tidak ada preset paket ${body.preset} di license.plans`);
    }
    await this.assertFirstAdminInvitable(body.firstAdmin.email);
    const mail = await checkMailReadiness(this.config);
    const mailRequired = this.config.profile.mail.required;
    if (!mail.ok && mailRequired) throw new ConflictError(mailRequiredMessage(mail.reason), { messageKey: 'mail_required' });

    const created = await this.provision(principal, body, timeZone);
    const operator = { userId: principal.user.id, kind: 'operator' as const };
    const invited: InvitedUser = await this.scope.withPlatform(
      async (trx) => {
        // Product decision 7: a new organisation allows local sign-in; the Tenant Admin changes the policy later.
        await trx.updateTable('platform.organization').set({ local_login: 'allowed' }).where('id', '=', created.id).execute();
        const user = await this.invitations.inviteUser(trx, {
          orgId: created.id,
          email: body.firstAdmin.email,
          displayName: body.firstAdmin.displayName,
          adminRoles: ['tenant_admin'],
          actor: operator,
        });
        if (!user.invitation) {
          // An existing active account: the invited membership, the email and the notification (J.4).
          this.invitations.notifyInvitedAccount(trx, {
            userId: user.userId,
            email: user.email,
            orgId: created.id,
            orgName: body.name.trim(),
            invitedBy: principal.user.displayName,
            actorUserId: principal.user.id,
          });
        }
        await this.audit.record(trx, {
          action: 'ops.organization_created',
          actor: operator,
          organizationId: created.id,
          entityType: 'organization',
          entityId: created.id,
          entityCode: created.slug,
          after: {
            slug: created.slug,
            name: body.name.trim(),
            timeZone,
            siteCount: body.siteCount,
            localLogin: 'allowed',
            preset: body.preset ?? null,
            firstAdmin: { userId: user.userId, handle: user.handle, newAccount: user.newAccount },
            mailReady: mail.ok,
          },
        });
        return user;
      },
      { scope: 'operator', orgId: created.id, userId: principal.user.id, requestId: currentRequestId() },
    );

    let sent = false;
    if (invited.invitation) {
      sent = mail.ok
        ? await this.mailer.send({
            to: { email: invited.email, userId: invited.userId },
            template: { name: 'invitation', link: invited.invitation.link, organisation: body.name.trim(), hours: INVITATION_TTL_MS / 3_600_000 },
          })
        : false;
    } else {
      sent = mail.ok;
    }
    // The one-time link only where mail is not required and the email did not go out (never on SaaS).
    const invitationUrl = !sent && !mailRequired && invited.invitation ? invited.invitation.link : undefined;
    const slug = created.slug;
    const message: [string, string] = [
      `Organisation created. The slug ${slug} cannot be changed. ` +
        (sent
          ? `The invitation was sent to ${invited.email}.`
          : invitationUrl
            ? 'Mail is not configured: give the one-time invitation link to the first administrator yourself.'
            : 'The invitation email could not be sent; invite the first administrator again with "mscd-server admin create-user".'),
      `Organisasi dibuat. Slug ${slug} tidak dapat diubah. ` +
        (sent
          ? `Undangan dikirim ke ${invited.email}.`
          : invitationUrl
            ? 'Email belum dikonfigurasi: berikan sendiri tautan undangan sekali pakai kepada administrator pertama.'
            : 'Email undangan tidak dapat dikirim; undang lagi administrator pertama dengan "mscd-server admin create-user".'),
    ];
    if (!sent) this.logger.warn({ orgId: created.id }, `The invitation of the first administrator of ${slug} was not emailed`);
    return {
      ok: true,
      changed: [],
      message,
      data: { id: created.id, slug, invitationSent: sent, ...(invitationUrl ? { invitationUrl } : {}) },
    };
  }

  /** Refuses a first administrator whose account is disabled before anything is created (409). */
  private async assertFirstAdminInvitable(email: string): Promise<void> {
    const existing = await this.scope.withPlatform(
      (trx) =>
        trx
          .selectFrom('platform.app_user')
          .select(['status'])
          .where(sql<string>`lower(email)`, '=', email.trim().toLowerCase())
          .where('kind', '<>', 'guest')
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      { scope: 'operator' },
    );
    if (existing?.status === 'disabled') {
      throw new ConflictError('The account of this email address is disabled; choose another first administrator', { messageKey: 'first_admin_disabled' });
    }
  }

  /** `TenantProvisioner.create` as the database owner, with a data key of the storage gateway. */
  private async provision(principal: Principal, body: OpsOrganizationCreate, timeZone: string): Promise<CreatedTenant> {
    let connectionString: string;
    try {
      connectionString = this.config.databaseUrl('migrator');
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new DependencyUnavailableError('Creating an organisation needs the database owner role in the api (database.migrator_url_file)', { cause: error });
      }
      throw error;
    }
    const keys = this.dataKeys.open();
    try {
      return await new TenantProvisioner({ connectionString, dataKeys: keys.issuer }).create({
        slug: body.slug,
        name: body.name,
        timeZone,
        siteCount: body.siteCount,
        actor: { kind: 'user', userId: principal.user.id, requestId: currentRequestId() ?? null },
      });
    } catch (error) {
      if (!(error instanceof TenantProvisioningError)) throw error;
      if (/already exists|already used/.test(error.message)) throw new ConflictError(error.message, { messageKey: 'org_exists' });
      if (/time zone/i.test(error.message)) throw new ValidationError([{ path: 'body.timeZone', message: error.message }]);
      if (/data key|storage gateway/i.test(error.message)) throw new DependencyUnavailableError(error.message, { cause: error });
      throw new ValidationError([{ path: 'body', message: error.message }]);
    } finally {
      await keys.close();
    }
  }
}
