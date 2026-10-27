// Helpers of the onboarding integration tests (Milestone 2 M2-06): the full api application (as `mscd-server api`
// builds it) on a test database with Mailpit for the emails, fresh organisations made by `TenantProvisioner`, people
// with memberships in any organisation, sessions written through `SessionService` (as the contract harness does, for
// organisations that are not demo organisations), role grants and tenant reads.
import { sql, type Transaction } from 'kysely';
import type { BusinessRole, OrgRole } from '@mscd/shared';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { NO_ORGANISATION } from '../../../src/modules/authz/authz-infra';
import { hashSecret } from '../../../src/modules/identity/password-hasher';
import { SessionService } from '../../../src/modules/identity/session.service';
import { TenantDataKeys } from '../../../src/modules/ops/tenant-data-keys';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { TestDataKeyIssuer } from '../../setup/global-db';
import type { TestDatabase } from '../../setup/test-db';
import { Client, createFullApp, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import type { Mailpit } from '../identity/helpers';

export { Client };

/** A password that meets the policy (F.4). */
export const PASSWORD = 'Correct-Horse-Battery-77';

/**
 * The api application with mail going to `mail` (or to a closed port), and organisations created by the operator
 * getting their data key from a local issuer instead of the storage gateway.
 */
export async function createOnboardingApp(db: TestDatabase, options: { mail?: Mailpit | null; env?: Record<string, string> } = {}): Promise<FullApp> {
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.mail) {
    env.MSCD__MAIL__SMTP__HOST = options.mail.host;
    env.MSCD__MAIL__SMTP__PORT = String(options.mail.smtpPort);
  }
  const full = await createFullApp(db, env);
  const keys = full.get<TenantDataKeys>(TenantDataKeys);
  keys.open = () => ({ issuer: new TestDataKeyIssuer(), close: async () => undefined });
  return full;
}

export interface Person {
  id: string;
  handle: string;
  email: string;
  displayName: string;
}

let hashed: Promise<string> | undefined;

/** A person with memberships (active unless stated) and optionally the platform operator role and a password. */
export async function addPerson(
  db: TestDatabase,
  handle: string,
  memberships: { org: { id: string }; adminRoles?: OrgRole[]; status?: 'active' | 'invited' | 'disabled'; isDefault?: boolean; invitedBy?: string | null }[],
  options: { platformOperator?: boolean; password?: boolean; status?: 'active' | 'invited' | 'disabled'; domain?: string } = {},
): Promise<Person> {
  hashed ??= hashSecret(PASSWORD);
  const email = `${handle}@${options.domain ?? 'onboarding.test'}`;
  const displayName = `Person ${handle}`;
  const passwordHash = options.password ? await hashed : null;
  const id = await inScope(db.migrator, { platformScope: true }, async (trx) => {
    const user = await trx
      .insertInto('platform.app_user')
      .values({ handle, email, display_name: displayName, kind: 'person', status: options.status ?? 'active', password_hash: passwordHash, mfa_required: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [index, m] of memberships.entries()) {
      await trx
        .insertInto('platform.org_membership')
        .values({
          organization_id: m.org.id,
          user_id: user.id,
          admin_roles: m.adminRoles ?? [],
          status: m.status ?? 'active',
          is_default: m.isDefault ?? index === 0,
          invited_by: m.invitedBy ?? null,
        })
        .execute();
    }
    if (options.platformOperator) await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator' }).execute();
    return user.id;
  });
  return { id, handle, email, displayName };
}

/** A signed-in client of a person in an organisation (or without one), as after a full sign-in with both factors. */
export async function sessionIn(
  full: FullApp,
  userId: string,
  org: { id: string; schemaName: string } | null,
  options: { mfaAt?: Date | null; passwordAt?: Date | null } = {},
): Promise<Client> {
  const sessions = full.get<SessionService>(SessionService);
  const scope = full.get<TenantScope>(TenantScope);
  const context = org ? { orgId: org.id, schema: org.schemaName, userId } : { ...NO_ORGANISATION, userId };
  const now = new Date();
  const issued = await scope.withTenant(context, (trx) =>
    sessions.create(trx, {
      userId,
      organizationId: org?.id ?? null,
      authOrgId: org?.id ?? null,
      state: 'active',
      authMethod: 'local',
      passwordAt: options.passwordAt === undefined ? now : options.passwordAt,
      mfaAt: options.mfaAt === undefined ? now : options.mfaAt,
    }),
  );
  return new Client(full.app, issued.cookieValue, issued.csrfToken);
}

/** Runs `fn` as the migrator in an organisation's schema. */
export function inTenant<T>(db: TestDatabase, tenant: CreatedTenant, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, fn);
}

/** Runs `fn` as the migrator with platform scope. */
export function inPlatform<T>(db: TestDatabase, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return inScope(db.migrator, { platformScope: true }, fn);
}

/** A business role grant in a system. */
export async function grantRole(
  db: TestDatabase,
  tenant: CreatedTenant,
  msId: string,
  userId: string,
  role: BusinessRole,
  options: { isPrimary?: boolean; approval?: 'active' | 'pending_approval'; requestedBy?: string | null; validUntil?: Date | null } = {},
): Promise<string> {
  const row = await inTenant(db, tenant, (trx) =>
    trx
      .insertInto('user_ms_role')
      .values({
        user_id: userId,
        management_system_id: msId,
        role,
        is_primary: options.isPrimary ?? false,
        approval_status: options.approval ?? 'active',
        requested_by: options.requestedBy ?? null,
        valid_until: options.validUntil ?? (role === 'external_auditor' ? new Date(Date.now() + 7 * 86_400_000) : null),
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** Platform audit entries of an action, oldest first. */
export async function platformAudit(db: TestDatabase, action: string): Promise<{ organization_id: string | null; actor_kind: string; actor_user_id: string | null; entity_id: string | null; entity_code: string | null; after_data: unknown }[]> {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['organization_id', 'actor_kind', 'actor_user_id', 'entity_id', 'entity_code', 'after_data'])
      .where('action', '=', action)
      .orderBy('seq')
      .execute(),
  );
}

/** Tenant audit entries of an action, oldest first. */
export async function tenantAudit(db: TestDatabase, tenant: CreatedTenant, action: string): Promise<{ management_system_id: string | null; entity_id: string | null; before_data: unknown; after_data: unknown }[]> {
  return inTenant(db, tenant, (trx) =>
    trx.selectFrom('audit_trail').select(['management_system_id', 'entity_id', 'before_data', 'after_data']).where('action', '=', action).orderBy('seq').execute(),
  );
}

/** Forgets the route rate-limit buckets, keeping the second-factor failure counters. */
export async function resetRateLimits(db: TestDatabase): Promise<void> {
  await sql`delete from platform.rate_limit_bucket where key not like 'mfa-fail:%'`.execute(db.migrator);
}
