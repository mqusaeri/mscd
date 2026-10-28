// Organisations of the platform operator (Milestone 2 D.1, D.2, K.6; M2-06 and M2-S09), multi tenancy only (single
// tenancy answers 409 `conflict` with messageKey `single_tenancy`, H.12):
// - `GET /ops/organizations`: every organisation that is not deleted, with status, licence state, plan and validity
//   of the entitlement row, active members (guests not counted), systems that are not archived, verified email
//   domains and the creation time; search by slug or name and a status filter, paged.
// - `GET /ops/organizations/{org}` (M2-S09): one organisation with its status, region, creation time, members,
//   systems, entitlement summary, email domains (every status) and the time of the last completed sign-in.
// - `GET /ops/organizations/{org}/events` (M2-S09): the status history of `platform.organization_status_event`,
//   newest first, with the operator who made each move.
// - `POST /ops/organizations`: creates the organisation with `TenantProvisioner.create` (schema, tenant migrations,
//   data key from the storage gateway, Managed Vault repository, `tenant.created`) in the region of
//   `tenancy.default_region` (M2-S09), with local sign-in allowed (product decision 7 of CLAUDE.md), writes the plan
//   preset of `license.plans` when the body names one (`EntitlementService.applyPreset` of M2-S10, M2-S09), and invites
//   its first administrator as Tenant Admin. The invitation is emailed; with `mail.required` (SaaS) nothing is created
//   while SMTP does not work (409 `mail_required`) and the link is never returned; without it and with mail off, the
//   response carries the one-time link once. An existing active account gets an invited membership, the email and the
//   notification `membership_invited` instead of a link. Audited `ops.organization_created`.
// The command line uses the same service: `tenant onboard` is `create`, `tenant list` and `tenant show` read through
// `list` and `detail` (also in single tenancy, where only the routes refuse), with the actor `CLI_OPERATOR`.
// Writes to platform tables run in platform scope (M2-02 follow-up 9); the organisation's own schema is written by the
// provisioner as its owner.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  OpsOrganizationCreate,
  OpsOrganizationCreateResult,
  OpsOrganizationDetail,
  OpsOrganizationItem,
  OpsOrganizationListQuery,
  OrganizationEventsQuery,
  OrganizationStatusEventItem,
  Page,
} from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { ConflictError, DependencyUnavailableError, NotFoundError, ProblemError, ValidationError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { ConfigError, MscdConfig } from '../../config/mscd-config';
import { TenantProvisioner, TenantProvisioningError, type CreatedTenant, type ProvisioningActor } from '../../db/tenant-provisioner';
import { canonicalTimeZone } from '../admin-users/time-zone';
import { AccountMailer } from '../identity/account-mailer';
import { INVITATION_TTL_MS, InvitationService } from '../identity/invitation.service';
import type { EntitlementRecord } from '../license/entitlement-row';
import { EntitlementService } from '../license/entitlement.service';
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

/**
 * Who acts on the organisations of the operator: a signed-in platform operator (the routes) or the operator command
 * line (`tenant onboard`, `tenant set-status`), which has no user. Audit entries get actor kind `operator` either way.
 */
export interface OperatorActor {
  /** The operator's user id; null for the command line. */
  userId: string | null;
  /** The operator's display name (the invitation notice names who invited); null for the command line. */
  displayName: string | null;
  /** Platform scope kind of the transactions (F.10). */
  scope: 'operator' | 'cli';
}

/** The operator of a request. */
export function operatorOf(principal: Principal): OperatorActor {
  return { userId: principal.user.id, displayName: principal.user.displayName, scope: 'operator' };
}

/** The operator command line (`mscd-server tenant ...`). */
export const CLI_OPERATOR: OperatorActor = Object.freeze({ userId: null, displayName: null, scope: 'cli' });

/** 409 `conflict` with messageKey `single_tenancy` (J.6). */
export function singleTenancyRefusal(): ConflictError {
  return new ConflictError('This installation runs one organisation (tenancy.mode single); organisations are created with the installer', {
    messageKey: 'single_tenancy',
  });
}

/** 404 for an organisation slug that names no organisation (deleted ones included). */
export function unknownOrganisation(slug: string): NotFoundError {
  return new NotFoundError(`Unknown organisation ${slug}`);
}

function rule(detail: string, messageKey: string, id: string): ProblemError {
  return new ProblemError('business-rule', { detail, messageKey, messages: { en: detail, id } });
}

/** Options of the reads that the command line also uses in single tenancy. */
export interface OperatorReadOptions {
  /** True for `tenant list` and `tenant show`: single tenancy reads its one organisation instead of answering 409. */
  anyTenancy?: boolean;
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
    private readonly entitlements: EntitlementService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private assertMultiTenancy(options: OperatorReadOptions = {}): void {
    if (options.anyTenancy) return;
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
  }

  /** `GET /ops/organizations`. */
  async list(query: OpsOrganizationListQuery, options: OperatorReadOptions = {}): Promise<Page<OpsOrganizationItem>> {
    this.assertMultiTenancy(options);
    const search = query.q ? `%${query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = sql`o.deleted_at is null
      ${query.status ? sql`and o.status = ${query.status}` : sql``}
      ${search ? sql`and (lower(o.slug) like ${search} or lower(o.name) like ${search})` : sql``}`;
    const { total, rows } = await this.scope.withPlatform(
      async (trx) => {
        const counted = await sql<{ n: string }>`select count(*) as n from platform.organization o where ${where}`.execute(trx);
        const listed = await sql<OrganizationRow>`
          select o.id, o.slug, o.name, o.schema_name, o.status, o.created_at,
                 ${memberCount(sql.ref('o.id'))} as member_count,
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
        const evaluated = await this.licences.evaluate(trx, row.id, { reportRollback: false });
        return {
          systems: await countSystems(trx),
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

  /**
   * `GET /ops/organizations/{org}` (M2-S09): 404 for an unknown slug. The entitlement summary comes from the licence
   * read, which also writes the row of a signed licence installed before M2-S10 (once, as the list does).
   */
  async detail(slug: string, options: OperatorReadOptions = {}): Promise<OpsOrganizationDetail> {
    this.assertMultiTenancy(options);
    const found = await this.scope.withPlatform(
      async (trx) => {
        const org = await trx
          .selectFrom('platform.organization')
          .select(['id', 'slug', 'name', 'schema_name', 'status', 'region', 'created_at'])
          .where('slug', '=', slug)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!org) return null;
        const counts = await sql<{ members: string; last_sign_in: Date | null }>`
          select ${memberCount(sql.val(org.id))} as members,
                 (select max(s.created_at) from platform.session s
                   where (s.organization_id = ${org.id} or s.auth_org_id = ${org.id}) and s.state = 'active') as last_sign_in`.execute(trx);
        const domains = await trx
          .selectFrom('platform.verified_domain')
          .select(['domain', 'status'])
          .where('organization_id', '=', org.id)
          .orderBy('domain')
          .execute();
        return { org, members: Number(counts.rows[0]?.members ?? 0), lastSignIn: counts.rows[0]?.last_sign_in ?? null, domains };
      },
      { scope: 'operator' },
    );
    if (!found) throw unknownOrganisation(slug);
    const { org } = found;
    const { systems, entitlement } = await this.scope.withTenant(systemContextOf({ id: org.id, schema: org.schema_name }), async (trx) => {
      const evaluated = await this.licences.evaluate(trx, org.id, { reportRollback: false });
      return { systems: await countSystems(trx), entitlement: evaluated?.entitlement ?? null };
    });
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      status: org.status,
      region: org.region,
      createdAt: new Date(org.created_at).toISOString(),
      memberCount: found.members,
      systemCount: systems,
      entitlement: entitlementSummary(entitlement),
      domains: found.domains.map((d) => ({ domain: d.domain, status: d.status })),
      lastSignInAt: found.lastSignIn ? new Date(found.lastSignIn).toISOString() : null,
    };
  }

  /** `GET /ops/organizations/{org}/events` (M2-S09): the status history, newest first; 404 for an unknown slug. */
  async events(slug: string, query: OrganizationEventsQuery, options: OperatorReadOptions = {}): Promise<Page<OrganizationStatusEventItem>> {
    this.assertMultiTenancy(options);
    const page = await this.scope.withPlatform(
      async (trx) => {
        const org = await trx.selectFrom('platform.organization').select('id').where('slug', '=', slug).where('deleted_at', 'is', null).executeTakeFirst();
        if (!org) return null;
        const counted = await trx
          .selectFrom('platform.organization_status_event')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('organization_id', '=', org.id)
          .executeTakeFirstOrThrow();
        const rows = await trx
          .selectFrom('platform.organization_status_event as e')
          .leftJoin('platform.app_user as u', 'u.id', 'e.actor_user_id')
          .select(['e.id', 'e.from_status', 'e.to_status', 'e.reason', 'e.created_at', 'u.handle', 'u.display_name'])
          .where('e.organization_id', '=', org.id)
          .orderBy('e.created_at', 'desc')
          .orderBy('e.id', 'desc')
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize)
          .execute();
        return { total: Number(counted.n), rows };
      },
      { scope: 'operator' },
    );
    if (!page) throw unknownOrganisation(slug);
    return {
      items: page.rows.map((row) => ({
        id: row.id,
        from: row.from_status,
        to: row.to_status,
        reason: row.reason,
        actor: row.handle !== null && row.display_name !== null ? { handle: row.handle, displayName: row.display_name } : null,
        at: new Date(row.created_at).toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
    };
  }

  /** `POST /ops/organizations`, and `tenant onboard` with `CLI_OPERATOR`. */
  async create(actor: OperatorActor, body: OpsOrganizationCreate): Promise<OpsOrganizationCreateResult> {
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

    const created = await this.provision(actor, body, timeZone);
    const operator = { userId: actor.userId, kind: 'operator' as const };
    const region = this.config.profile.tenancy.default_region;
    const { invited, plan } = await this.scope.withPlatform(
      async (trx) => {
        // Product decision 7: a new organisation allows local sign-in; the Tenant Admin changes the policy later.
        await trx.updateTable('platform.organization').set({ local_login: 'allowed' }).where('id', '=', created.id).execute();
        // The plan preset (Milestone 2 D.2, M2-S10's applyPreset), before the invitation counts against its limits.
        const row = body.preset !== undefined
          ? await this.entitlements.applyPreset(trx, created.id, body.preset, { actor: operator, slug: created.slug })
          : null;
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
            invitedBy: actor.displayName,
            actorUserId: actor.userId,
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
            region,
            localLogin: 'allowed',
            preset: body.preset ?? null,
            ...(row ? { plan: { name: row.plan, validFrom: row.validFrom, validUntil: row.validUntil, version: row.version } } : {}),
            firstAdmin: { userId: user.userId, handle: user.handle, newAccount: user.newAccount },
            mailReady: mail.ok,
          },
        });
        return { invited: user, plan: row };
      },
      { scope: actor.scope, orgId: created.id, userId: actor.userId, requestId: currentRequestId() },
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
    const planText: [string, string] = plan
      ? [
          `The ${plan.plan ?? body.preset} plan applies from ${plan.validFrom}${plan.validUntil ? ` to ${plan.validUntil}` : ''}. `,
          `Paket ${plan.plan ?? body.preset} berlaku sejak ${plan.validFrom}${plan.validUntil ? ` sampai ${plan.validUntil}` : ''}. `,
        ]
      : ['', ''];
    const message: [string, string] = [
      `Organisation created. The slug ${slug} cannot be changed. ${planText[0]}` +
        (sent
          ? `The invitation was sent to ${invited.email}.`
          : invitationUrl
            ? 'Mail is not configured: give the one-time invitation link to the first administrator yourself.'
            : 'The invitation email could not be sent; invite the first administrator again with "mscd-server admin create-user".'),
      `Organisasi dibuat. Slug ${slug} tidak dapat diubah. ${planText[1]}` +
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
      data: {
        id: created.id,
        slug,
        invitationSent: sent,
        ...(invitationUrl ? { invitationUrl } : {}),
        ...(plan ? { plan: { name: plan.plan, validFrom: plan.validFrom, validUntil: plan.validUntil } } : {}),
      },
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
  private async provision(actor: OperatorActor, body: OpsOrganizationCreate, timeZone: string): Promise<CreatedTenant> {
    let connectionString: string;
    try {
      connectionString = this.config.databaseUrl('migrator');
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new DependencyUnavailableError('Creating an organisation needs the database owner role in the api (database.migrator_url_file)', { cause: error });
      }
      throw error;
    }
    const provisioningActor: ProvisioningActor = actor.userId
      ? { kind: 'user', userId: actor.userId, requestId: currentRequestId() ?? null }
      : { kind: 'operator', requestId: currentRequestId() ?? null };
    const keys = this.dataKeys.open();
    try {
      return await new TenantProvisioner({ connectionString, dataKeys: keys.issuer }).create({
        slug: body.slug,
        name: body.name,
        timeZone,
        siteCount: body.siteCount,
        region: this.config.profile.tenancy.default_region,
        actor: provisioningActor,
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

/** Active members of an organisation without guests (product decision 5), as an SQL expression. */
function memberCount(orgId: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`(select count(*) from platform.org_membership m join platform.app_user u on u.id = m.user_id
                       where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null
                         and u.kind = 'person' and u.status = 'active' and u.deleted_at is null)`;
}

/** Management systems that are not archived, read in the organisation's transaction. */
async function countSystems(trx: Trx): Promise<number> {
  const counted = await sql<{ n: string }>`select count(*) as n from management_system where deleted_at is null and status <> 'archived'`.execute(trx);
  return Number(counted.rows[0]?.n ?? 0);
}

/** The entitlement summary of the detail, or null without an entitlement row. */
function entitlementSummary(row: EntitlementRecord | null): OpsOrganizationDetail['entitlement'] {
  if (!row) return null;
  return { plan: row.plan, source: row.source, maxUsers: row.maxUsers, maxManagementSystems: row.maxManagementSystems, validUntil: row.validUntil };
}
