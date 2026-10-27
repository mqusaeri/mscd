// The onboarding checklist of `GET /admin/onboarding` (Milestone 2 D.5), computed from existing tables on every call.
// It answers states, counts and the primary MS Manager of each system (name and email) only, so the Tenant Admin
// sees no compliance content (F.6). The steps, in order:
//   licence         installed and valid; count = active users (guests not counted, product decision 5), limit = seats
//   second_admin    two or more active Tenant Admins (count)
//   sign_in         optional: an enabled identity provider through which someone has signed in (count = enabled)
//   local_login     optional: the local sign-in policy was set by an administrator
//   repository      a repository connected and tested, or the Managed Vault as default (count = usable repositories)
//   routing         an active routing rule (count)
//   systems         one or more management systems that are not archived (count)
//   team            active members without an administrator role (count)
//   per system, in display order (`ms`):
//     ms_manager      a primary MS Manager granted
//     verifiers       two or more people who hold `applicability.verify` in the system (count): with fewer, separation
//                     of duties lets no work reach Implemented
//     internal_auditor  optional: an Internal Auditor granted (count)
//     implementing    the system moved to implementing (or is certified)
//     applicability   entries exist (count); done by the MS Manager (`doneBy`, `assignee`)
//     audit_dates     a Stage 1 and a Stage 2 audit event planned (count of them); done by the MS Manager
//   pending_grants  role grants waiting for a second Tenant Admin (count); done when none waits
// A grant counts when it is active, not expired and held by an active person with an active membership.
import { Injectable, Optional } from '@nestjs/common';
import { PERMISSION_MATRIX, type BusinessRole, type OnboardingStep } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import type { Principal, Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { LicenceService } from '../license/licence.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { countActiveTenantAdmins } from './organization.service';

/** Business roles that hold `applicability.verify` in a system (F.6: MS Manager and Programme Owner). */
export const VERIFY_ROLES: readonly BusinessRole[] = PERMISSION_MATRIX['applicability.verify'].roles;

/** The web screen that completes each step (Milestone 2 G.2 screen ids). */
const SCREENS: Readonly<Record<OnboardingStep['key'], string>> = {
  licence: 'license',
  second_admin: 'users',
  sign_in: 'identity-providers',
  local_login: 'identity-providers',
  repository: 'storage',
  routing: 'routing',
  systems: 'systems',
  team: 'users',
  ms_manager: 'users',
  verifiers: 'users',
  internal_auditor: 'users',
  implementing: 'systems',
  applicability: 'controls',
  audit_dates: 'timeline',
  pending_grants: 'approvals',
};

interface SystemRow {
  id: string;
  slug: string;
  status: string;
}

function step(key: OnboardingStep['key'], state: OnboardingStep['state'], extra: Omit<OnboardingStep, 'key' | 'state' | 'screen'> = {}): OnboardingStep {
  return { key, state, screen: SCREENS[key], ...extra };
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly config: MscdConfig,
    @Optional() private readonly licences?: LicenceService,
  ) {}

  /** `GET /admin/onboarding`. */
  async checklist(principal: Principal): Promise<OnboardingStep[]> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No current organisation');
    const now = this.clock.now();
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const steps: OnboardingStep[] = [];

      // Licence: installed, verified and valid; seats used against the limit.
      const evaluated = this.licences ? await this.licences.evaluate(trx, org.id) : null;
      const seats = await this.activeUsers(trx, org.id);
      const limit = evaluated?.verified && evaluated.document ? evaluated.document.max_users : undefined;
      steps.push(step('licence', evaluated?.verified && evaluated.state === 'valid' ? 'done' : 'pending', { count: seats, ...(limit !== undefined ? { limit } : {}) }));

      const admins = await countActiveTenantAdmins(trx, org.id);
      steps.push(step('second_admin', admins >= 2 ? 'done' : 'pending', { count: admins }));

      const providers = await this.providers(trx, org.id);
      steps.push(step('sign_in', providers.tested > 0 ? 'done' : 'optional', { count: providers.enabled }));

      steps.push(step('local_login', (await this.localLoginSet(trx, org.id)) ? 'done' : 'optional'));

      const repositories = await this.usableRepositories(trx);
      steps.push(step('repository', repositories > 0 ? 'done' : 'pending', { count: repositories }));

      const rules = await this.count(trx, sql`select count(*) as n from storage_routing_rule where deleted_at is null and approval_status = 'active'`);
      steps.push(step('routing', rules > 0 ? 'done' : 'pending', { count: rules }));

      const systems = await trx
        .selectFrom('management_system')
        .select(['id', 'slug', 'status'])
        .where('deleted_at', 'is', null)
        .where('status', '<>', 'archived')
        .orderBy('position')
        .orderBy('slug')
        .execute();
      steps.push(step('systems', systems.length > 0 ? 'done' : 'pending', { count: systems.length }));

      const team = await this.teamMembers(trx, org.id);
      steps.push(step('team', team > 0 ? 'done' : 'pending', { count: team }));

      for (const system of systems) steps.push(...(await this.systemSteps(trx, org.id, system, now)));

      const pending = await this.count(
        trx,
        sql`select count(*) as n from user_ms_role r join management_system ms on ms.id = r.management_system_id
             where r.deleted_at is null and r.approval_status = 'pending_approval' and ms.deleted_at is null`,
      );
      steps.push(step('pending_grants', pending > 0 ? 'pending' : 'done', { count: pending }));
      return steps;
    });
  }

  /** The six steps of one system. */
  private async systemSteps(trx: Trx, orgId: string, system: SystemRow, now: Date): Promise<OnboardingStep[]> {
    const ms = system.slug;
    const holders = (roles: readonly BusinessRole[]) =>
      sql<{ user_id: string; is_primary: boolean; role: string; display_name: string; email: string }>`
        select r.user_id, r.is_primary, r.role, u.display_name, u.email
          from user_ms_role r
          join platform.app_user u on u.id = r.user_id
          join platform.org_membership m on m.user_id = r.user_id and m.organization_id = ${orgId}
         where r.management_system_id = ${system.id} and r.deleted_at is null and r.approval_status = 'active'
           and (r.valid_until is null or r.valid_until > ${now})
           and r.role in (${sql.join(roles.map((role) => sql`${role}`))})
           and u.status = 'active' and u.deleted_at is null and u.kind = 'person'
           and m.status = 'active' and m.deleted_at is null
         order by r.is_primary desc, r.created_at, u.display_name`.execute(trx);

    const managers = (await holders(['ms_manager'])).rows;
    const primary = managers.find((m) => m.is_primary) ?? null;
    const assignee = primary ? { name: primary.display_name, email: primary.email } : null;
    const verifiers = new Set((await holders(VERIFY_ROLES)).rows.map((r) => r.user_id)).size;
    const auditors = new Set((await holders(['internal_auditor'])).rows.map((r) => r.user_id)).size;
    const entries = await this.count(trx, sql`select count(*) as n from applicability_entry where management_system_id = ${system.id} and deleted_at is null`);
    const events = await trx
      .selectFrom('audit_event')
      .select('event_type')
      .where('management_system_id', '=', system.id)
      .where('deleted_at', 'is', null)
      .where('event_type', 'in', ['stage1', 'stage2'])
      .execute();
    const types = new Set(events.map((e) => e.event_type));
    return [
      step('ms_manager', primary ? 'done' : 'pending', { ms }),
      step('verifiers', verifiers >= 2 ? 'done' : 'pending', { ms, count: verifiers }),
      step('internal_auditor', auditors > 0 ? 'done' : 'optional', { ms, count: auditors }),
      step('implementing', system.status === 'implementing' || system.status === 'certified' ? 'done' : 'pending', { ms }),
      step('applicability', entries > 0 ? 'done' : 'pending', { ms, count: entries, doneBy: 'ms_manager', assignee }),
      step('audit_dates', types.has('stage1') && types.has('stage2') ? 'done' : 'pending', { ms, count: events.length, doneBy: 'ms_manager', assignee }),
    ];
  }

  private async count(trx: Trx, query: RawBuilder<unknown>): Promise<number> {
    const { rows } = await query.execute(trx);
    return Number((rows[0] as { n?: string } | undefined)?.n ?? 0);
  }

  /** Active people of the organisation (D-15: the licence user count, guests not counted). */
  private activeUsers(trx: Trx, orgId: string): Promise<number> {
    return this.count(
      trx,
      sql`select count(*) as n from platform.org_membership m join platform.app_user u on u.id = m.user_id
           where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null
             and u.kind = 'person' and u.status = 'active' and u.deleted_at is null`,
    );
  }

  /** Active people without an administrator role. */
  private teamMembers(trx: Trx, orgId: string): Promise<number> {
    return this.count(
      trx,
      sql`select count(*) as n from platform.org_membership m join platform.app_user u on u.id = m.user_id
           where m.organization_id = ${orgId} and m.status = 'active' and m.deleted_at is null and cardinality(m.admin_roles) = 0
             and u.kind = 'person' and u.status = 'active' and u.deleted_at is null`,
    );
  }

  /** Enabled identity providers, and those through which someone has signed in (the proof that it works). */
  private async providers(trx: Trx, orgId: string): Promise<{ enabled: number; tested: number }> {
    const { rows } = await sql<{ enabled: string; tested: string }>`
      select count(*) as enabled,
             count(*) filter (where exists (select 1 from platform.user_identity i where i.identity_provider_id = p.id and i.last_login_at is not null)) as tested
        from platform.identity_provider p
       where p.organization_id = ${orgId} and p.enabled and p.deleted_at is null`.execute(trx);
    return { enabled: Number(rows[0]?.enabled ?? 0), tested: Number(rows[0]?.tested ?? 0) };
  }

  /** True when an administrator set the local sign-in policy (or it is not the default `allowed`). */
  private async localLoginSet(trx: Trx, orgId: string): Promise<boolean> {
    const org = await trx.selectFrom('platform.organization').select('local_login').where('id', '=', orgId).executeTakeFirst();
    if (org && org.local_login !== 'allowed') return true;
    return (await this.count(trx, sql`select count(*) as n from audit_trail where action = 'org.settings_updated'`)) > 0;
  }

  /**
   * Repositories files can go to: one of another provider that is connected and was tested (a connection check
   * recorded `ok`), or the Managed Vault when the installation offers it (the default of a new organisation).
   */
  private async usableRepositories(trx: Trx): Promise<number> {
    const vault = this.config.profile.storage.adapters.enabled.includes('managed_vault');
    return this.count(
      trx,
      sql`select count(*) as n from storage_repository
           where deleted_at is null and connection_status = 'ok'
             and ((adapter <> 'managed_vault' and last_checked_at is not null) or (adapter = 'managed_vault' and ${vault}))`,
    );
  }
}
