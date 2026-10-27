// The organisation settings of the Tenant Admin (build plan F.4, D.3; Milestone 2 D.1, D.2):
// - `GET /admin/organization`: slug, name, time zone, site count, local sign-in policy, installation id (for licence
//   requests), tenancy mode and the number of active Tenant Admins;
// - `PATCH /admin/organization`: the local sign-in policy (`allowed`, `admins_only`, `disabled`; audited
//   `org.settings_updated`, as in Milestone 1) and the name, the IANA time zone and the number of sites (audited
//   `org.updated` with the values before and after). The slug never changes: it names the organisation's schema.
// Every change drops the organisation from the tenant resolver cache, so sign-in, `PUT /me/org` and local dates use
// the new values at once (F.7 cache rule). The daily jobs follow a time zone change from the first scheduler tick whose
// UTC hour starts after the change. The tick reads the `org.updated` entries so the jobs of the local day of the change
// run once (scheduler-tick.job.ts).
import { Inject, Injectable } from '@nestjs/common';
import type { OrganizationSettings, OrgPolicyPatch } from '@mscd/shared';
import { sql } from 'kysely';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { checkedTimeZone } from './time-zone';

/** How often `PATCH /admin/organization` runs when its transaction began in an earlier UTC hour (see below). */
const ATTEMPTS = 3;

/** Rolls back a transaction that began in an earlier UTC hour than the one in which it locked the organisation row. */
class BeganInEarlierHour extends Error {}

/**
 * Whether the transaction locked the organisation row in a later UTC hour than the one it began in. A time zone change
 * counts from the start of its transaction (the `occurred_at` of its `org.updated` entry), and the scheduler tick
 * applies it from the first slot whose UTC hour starts after that instant. The tick reads the changes after minute 0
 * of its hour, once the changes that hold their row have committed (scheduler-tick.job.ts). A change that began before
 * minute 0 and locked its row after that read would be missed by that tick, so it runs again in a new transaction.
 */
async function beganInEarlierHour(trx: Trx): Promise<boolean> {
  const { rows } = await sql<{ earlier: boolean }>`
    select floor(extract(epoch from now()) / 3600) < floor(extract(epoch from clock_timestamp()) / 3600) as earlier`.execute(trx);
  return rows[0]?.earlier === true;
}

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
        .select(['slug', 'name', 'time_zone', 'site_count', 'local_login'])
        .where('id', '=', org.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('No current organisation');
      return {
        slug: row.slug,
        name: row.name,
        timeZone: row.time_zone,
        siteCount: row.site_count,
        localLogin: row.local_login,
        installationId: (await trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow()).id,
        tenancyMode: this.config.profile.tenancy.mode,
        activeAdminCount: await countActiveTenantAdmins(trx, org.id),
      };
    });
  }

  /**
   * `PATCH /admin/organization`: one audit entry per kind of change; nothing is written when nothing changes. A time
   * zone change runs again in a new transaction when its transaction began in an earlier UTC hour than the one in
   * which it locked the organisation row (`beganInEarlierHour`).
   */
  async update(principal: Principal, patch: OrgPolicyPatch): Promise<void> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No current organisation');
    for (let attempt = 1; ; attempt++) {
      try {
        await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
          const current = await trx
            .selectFrom('platform.organization')
            .select(['slug', 'name', 'time_zone', 'site_count', 'local_login'])
            .where('id', '=', org.id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw new NotFoundError('No current organisation');
          // The last attempt writes in any case; two hour boundaries within one change do not happen.
          if (patch.timeZone !== undefined && attempt < ATTEMPTS && (await beganInEarlierHour(trx))) throw new BeganInEarlierHour();

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
        break;
      } catch (error) {
        if (error instanceof BeganInEarlierHour) continue;
        throw error;
      }
    }
    // After the commit: the next lookup reads the new values (F.7 cache rule).
    this.tenants.invalidate(org.id);
  }
}
