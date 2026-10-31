// The organisation settings of the Tenant Admin (build plan F.4, D.3; Milestone 2 D.1, D.2):
// - `GET /admin/organization`: slug, name, time zone, site count, local sign-in policy, installation id (for licence
//   requests), tenancy mode and the number of active Tenant Admins, with the weak ETag of the organisation row (from
//   `updated_at`, in the body and the `ETag` header);
// - `PATCH /admin/organization`: the local sign-in policy (`allowed`, `admins_only`, `disabled`; audited
//   `org.settings_updated`, as in Milestone 1) and the name, the IANA time zone and the number of sites (audited
//   `org.updated` with the values before and after). The slug never changes: it names the organisation's schema.
//   `If-Match` with the ETag of the GET is checked before anything is written (412 when another change came first,
//   R-18), so an admin with a stale form does not silently undo another admin's change.
// Every change drops the organisation from the tenant resolver cache, so sign-in, `PUT /me/org` and local dates use
// the new values at once (F.7 cache rule). The PATCH locks the organisation row `FOR NO KEY UPDATE`: it waits for
// another change of the row but not for the foreign key checks of rows that reference the organisation (they take a
// key share lock), so a transaction that holds the tenant audit chain lock and then inserts such a row (an auditor
// access grant) never deadlocks with it. The daily jobs follow a time zone change through the run ledger of
// `scheduler.tick`: each runs once per local date of the organisation (jobs/scheduler-tick.job.ts).
// Milestone 3 (D.2; M3-03): the GET adds, while the organisation is offboarding, the end of the read-only period
// (`offboardingEndsAt`) and the planned deletion date (`deletionScheduledFor`: the end plus
// `lifecycle.deletion_grace_days`), and while it is archived the scheduled date; both are null otherwise (the banner of
// M3-09 shows them).
import { Inject, Injectable } from '@nestjs/common';
import type { OrganizationSettings, OrgPolicyPatch } from '@mscd/shared';
import { sql } from 'kysely';
import { assertIfMatch, etagOf } from '../../common/etag';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { checkedTimeZone } from './time-zone';

/** Active Tenant Admins of an organisation: active membership with the role, active person account. */
export async function countActiveTenantAdmins(trx: Trx, orgId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    select count(*) as n
      from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
     where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null
       and 'tenant_admin' = any(m.admin_roles)
       and u.status = 'active' and u.deleted_at is null and u.kind = 'person'`.execute(trx);
  return Number(rows[0]?.n ?? 0);
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly config: MscdConfig,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `GET /admin/organization` (Milestone 2 D.1). */
  async get(principal: Principal): Promise<OrganizationSettings> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No current organisation');
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await trx
        .selectFrom('platform.organization')
        .select(['slug', 'name', 'time_zone', 'site_count', 'local_login', 'updated_at', 'status', 'offboarding_ends_at'])
        .where('id', '=', org.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('No current organisation');
      const lifecycle = await this.lifecycleOf(trx, org.id, row.status, row.offboarding_ends_at);
      return {
        slug: row.slug,
        name: row.name,
        timeZone: row.time_zone,
        siteCount: row.site_count,
        localLogin: row.local_login,
        installationId: (await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow()).id,
        tenancyMode: this.config.profile.tenancy.mode,
        activeAdminCount: await countActiveTenantAdmins(trx, org.id),
        etag: etagOf(row.updated_at),
        ...lifecycle,
      };
    });
  }

  /** The read-only end and the deletion date of D.2; null when the organisation has none. */
  private async lifecycleOf(
    trx: Trx,
    orgId: string,
    status: string,
    offboardingEndsAt: Date | null,
  ): Promise<Pick<OrganizationSettings, 'offboardingEndsAt' | 'deletionScheduledFor'>> {
    if (status === 'offboarding' && offboardingEndsAt) {
      const graceMs = this.config.profile.lifecycle.deletion_grace_days * 86_400_000;
      return {
        offboardingEndsAt: offboardingEndsAt.toISOString(),
        deletionScheduledFor: new Date(offboardingEndsAt.getTime() + graceMs).toISOString(),
      };
    }
    if (status === 'archived') {
      const deletion = await trx
        .selectFrom('platform.organization_deletion')
        .select('scheduled_for')
        .where('organization_id', '=', orgId)
        .where('status', 'in', ['scheduled', 'running'])
        .executeTakeFirst();
      return { offboardingEndsAt: null, deletionScheduledFor: deletion ? deletion.scheduled_for.toISOString() : null };
    }
    return { offboardingEndsAt: null, deletionScheduledFor: null };
  }

  /**
   * `PATCH /admin/organization`: one audit entry per kind of change; nothing is written when nothing changes. A stale
   * `If-Match` answers 412 before anything is written.
   */
  async update(principal: Principal, patch: OrgPolicyPatch, ifMatch?: string): Promise<void> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No current organisation');
    await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const current = await trx
        .selectFrom('platform.organization')
        .select(['slug', 'name', 'time_zone', 'site_count', 'local_login', 'updated_at'])
        .where('id', '=', org.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundError('No current organisation');
      assertIfMatch(ifMatch, current.updated_at, current.slug);

      if (patch.localLogin !== undefined && current.local_login !== patch.localLogin) {
        await trx.updateTable('platform.organization').set({ local_login: patch.localLogin }).where('id', '=', org.id).execute();
        await this.audit.record(trx, {
          action: 'org.settings_updated',
          entityType: 'organization',
          entityId: org.id,
          entityCode: org.slug,
          before: { localLogin: current.local_login },
          after: { localLogin: patch.localLogin },
        });
      }

      const changes: { name?: string; time_zone?: string; site_count?: number } = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (patch.name !== undefined && patch.name.trim() !== current.name) {
        changes.name = patch.name.trim();
        [before.name, after.name] = [current.name, changes.name];
      }
      if (patch.timeZone !== undefined) {
        const zone = await checkedTimeZone(trx, patch.timeZone);
        if (zone !== current.time_zone) {
          changes.time_zone = zone;
          [before.timeZone, after.timeZone] = [current.time_zone, zone];
        }
      }
      if (patch.siteCount !== undefined && patch.siteCount !== current.site_count) {
        changes.site_count = patch.siteCount;
        [before.siteCount, after.siteCount] = [current.site_count, patch.siteCount];
      }
      if (Object.keys(changes).length > 0) {
        await trx.updateTable('platform.organization').set(changes).where('id', '=', org.id).execute();
        await this.audit.record(trx, {
          action: 'org.updated',
          entityType: 'organization',
          entityId: org.id,
          entityCode: current.slug,
          before,
          after,
        });
      }
    });
    // After the commit: the next lookup reads the new values (F.7 cache rule).
    this.tenants.invalidate(org.id);
  }
}
