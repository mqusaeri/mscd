// Helpers of the organisation lifecycle tests (Milestone 2 K.6, M2-S09): the multi-tenancy api application with two
// plan presets, the status routes, the status of an organisation as stored, its status events and audit entries, and
// sessions written directly (for a session opened through one organisation and moved to another).
import { API_ROUTES, type OrganizationStatus, type OrganizationStatusChangeResult } from '@mscd/shared';
import { sql } from 'kysely';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { SessionService } from '../../../src/modules/identity/session.service';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { TestDatabase } from '../../setup/test-db';
import { Client, callRoute, type FullApp, type RouteCall } from '../contract/harness';
import { inPlatform } from '../onboarding/helpers';

export { MULTI, PLANS } from '../entitlements/helpers';

export const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
export const GET = route('ops.organizations.get');
export const STATUS = route('ops.organizations.status');
export const EVENTS = route('ops.organizations.events');
export const CREATE = route('ops.organizations.create');
export const LIST = route('ops.organizations.list');

/** The problem type URL of a slug, as the problem filter writes it. */
export const problemType = (slug: string) => `https://mscd.cyberlentera.com/problems/${slug}`;

/** The answer of the status route: the result on success, a problem otherwise (tests read either). */
export type StatusAnswer = OrganizationStatusChangeResult & { type?: string; messageKey?: string; messages: { en: string; id: string } };

/** `POST /ops/organizations/{org}/status` with the route contract checked. */
export function setStatus(op: Client, org: string, body: { status: OrganizationStatus; reason: string; confirmSlug?: string }): Promise<RouteCall<StatusAnswer>> {
  return callRoute<StatusAnswer>(op, STATUS, { params: { org }, body });
}

/** The stored status of an organisation. */
export async function statusOf(db: TestDatabase, orgId: string): Promise<OrganizationStatus> {
  const row = await inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('status').where('id', '=', orgId).executeTakeFirstOrThrow());
  return row.status;
}

/** Sets the status of an organisation as the database owner (fixtures; the trigger lets the owner through). */
export async function forceStatus(db: TestDatabase, orgId: string, status: OrganizationStatus): Promise<void> {
  await sql`update platform.organization set status = ${status} where id = ${orgId}`.execute(db.migrator);
}

/** The status events of an organisation, oldest first. */
export async function eventsOf(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.organization_status_event')
      .select(['id', 'from_status', 'to_status', 'reason', 'actor_user_id'])
      .where('organization_id', '=', orgId)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  );
}

/** The `ops.organization_status_changed` entries of an organisation, oldest first. */
export async function statusAudit(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['actor_kind', 'actor_user_id', 'entity_type', 'entity_id', 'entity_code', 'before_data', 'after_data'])
      .where('action', '=', 'ops.organization_status_changed')
      .where('organization_id', '=', orgId)
      .orderBy('seq')
      .execute(),
  );
}

/** A signed-in client whose session was opened through `authOrg` and whose current organisation is `currentOrg`. */
export async function movedSession(full: FullApp, userId: string, authOrg: CreatedTenant, currentOrg: CreatedTenant): Promise<Client> {
  const sessions = full.get<SessionService>(SessionService);
  const scope = full.get<TenantScope>(TenantScope);
  const now = new Date();
  const issued = await scope.withTenant({ orgId: currentOrg.id, schema: currentOrg.schemaName, userId }, (trx) =>
    sessions.create(trx, {
      userId,
      organizationId: currentOrg.id,
      authOrgId: authOrg.id,
      state: 'active',
      authMethod: 'local',
      passwordAt: now,
      mfaAt: now,
    }),
  );
  return new Client(full.app, issued.cookieValue, issued.csrfToken);
}

/** The revoke reasons of a user's sessions by current organisation. */
export async function sessionStates(db: TestDatabase, userId: string): Promise<{ organization_id: string | null; revoke_reason: string | null }[]> {
  return inPlatform(db, (trx) =>
    trx.selectFrom('platform.session').select(['organization_id', 'revoke_reason']).where('user_id', '=', userId).orderBy('created_at').execute(),
  );
}
