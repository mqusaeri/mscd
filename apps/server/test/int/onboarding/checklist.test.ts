// `GET /admin/onboarding` (Milestone 2 D.5) on a fresh organisation with no demo data: every step from its first
// state to done, the per-system steps with `doneBy` and `assignee`, counts only (no compliance content, F.6), and the
// system creation of D2-09 (`admin.ms.create` seeds one applicability entry per catalogue item plus one per leaf
// requirement row of the installed ISO/IEC 27001 pack, the count computed from the pack; audited
// `applicability.seeded`).
import { API_ROUTES, OnboardingStep } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { devLicence, installDevPacks } from '../packs/fixtures';
import { addPerson, createOnboardingApp, grantRole, inPlatform, inTenant, resetRateLimits, sessionIn, tenantAudit, type Client, type Person } from './helpers';

const ONBOARDING = API_ROUTES.find((r) => r.id === 'admin.onboarding')!;
const STEP_KEYS = new Set(['key', 'state', 'screen', 'count', 'limit', 'ms', 'doneBy', 'assignee']);

describe('onboarding checklist (Milestone 2 D.5)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let tenant: CreatedTenant;
  let admin: Person;
  let ta: Client;
  let msId: string;

  const steps = async (client: Client = ta): Promise<OnboardingStep[]> => {
    await resetRateLimits(db);
    const call = await callRoute<OnboardingStep[]>(client, ONBOARDING, {});
    expect(call.violations).toEqual([]);
    expect(call.status).toBe(200);
    for (const step of call.body) {
      expect(OnboardingStep.safeParse(step).success).toBe(true);
      expect(Object.keys(step).filter((k) => !STEP_KEYS.has(k))).toEqual([]);
    }
    return call.body;
  };
  const step = (list: OnboardingStep[], key: OnboardingStep['key'], ms?: string) => {
    const found = list.find((s) => s.key === key && (ms === undefined || s.ms === ms));
    expect(found, `${key}${ms ? ` of ${ms}` : ''}`).toBeDefined();
    return found!;
  };
  const shape = (s: OnboardingStep) => ({ state: s.state, count: s.count ?? null });

  beforeAll(async () => {
    await installDevPacks(db, ['ISO27001-2022']);
    tenant = await createTenant(db, 'fresh', { name: 'PT Fresh Start' });
    admin = await addPerson(db, 'fresh.admin', [{ org: tenant, adminRoles: ['tenant_admin'] }], { password: true });
    full = await createOnboardingApp(db);
    ta = await sessionIn(full, admin.id, tenant);
  });
  afterAll(async () => {
    await full?.close();
  });

  it('shows a fresh organisation: licence, second admin, routing, systems and team to do, the Managed Vault ready', async () => {
    const list = await steps();
    expect(list.map((s) => [s.key, s.state, s.count ?? null, s.screen])).toEqual([
      ['licence', 'pending', 1, 'license'],
      ['second_admin', 'pending', 1, 'users'],
      ['sign_in', 'optional', 0, 'identity-providers'],
      ['local_login', 'optional', null, 'identity-providers'],
      ['repository', 'done', 1, 'storage'],
      ['routing', 'pending', 0, 'routing'],
      ['systems', 'pending', 0, 'systems'],
      ['team', 'pending', 0, 'users'],
      ['pending_grants', 'done', 0, 'approvals'],
    ]);
    expect(step(list, 'licence').limit).toBeUndefined();
  });

  it('marks the licence, the second administrator, sign-in, the policy, repositories and routing done as they happen', async () => {
    // Licence: installed and valid, with the seats used and the limit.
    const installed = await ta.put('/api/v1/admin/license', devLicence(tenant.id, { max_users: 25 }));
    expect(installed.status, installed.text).toBe(200);
    expect(step(await steps(), 'licence')).toMatchObject({ state: 'done', count: 1, limit: 25 });

    // A second active Tenant Admin; an invited or disabled one does not count.
    await addPerson(db, 'fresh.invited.admin', [{ org: tenant, adminRoles: ['tenant_admin'], status: 'invited' }]);
    expect(shape(step(await steps(), 'second_admin'))).toEqual({ state: 'pending', count: 1 });
    await addPerson(db, 'fresh.admin2', [{ org: tenant, adminRoles: ['tenant_admin'] }]);
    expect(shape(step(await steps(), 'second_admin'))).toEqual({ state: 'done', count: 2 });

    // Sign-in: a saved provider stays optional until someone signed in through it.
    const providerId = await inPlatform(db, async (trx) => {
      const row = await trx
        .insertInto('platform.identity_provider')
        .values({ organization_id: tenant.id, slug: 'entra', kind: 'oidc', display_name: 'Sign in with Entra', oidc_issuer: 'https://login.example.test/v2.0', oidc_client_id: 'mscd' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    expect(shape(step(await steps(), 'sign_in'))).toEqual({ state: 'optional', count: 1 });
    await inPlatform(db, (trx) =>
      trx.insertInto('platform.user_identity').values({ identity_provider_id: providerId, subject: 'sub-1', user_id: admin.id, link_method: 'session', last_login_at: new Date() }).execute(),
    );
    expect(shape(step(await steps(), 'sign_in'))).toEqual({ state: 'done', count: 1 });

    // Local sign-in policy: the same value changes nothing; a set policy stays done after a change back.
    expect((await ta.patch('/api/v1/admin/organization', { localLogin: 'allowed' })).status).toBe(204);
    expect(step(await steps(), 'local_login').state).toBe('optional');
    expect((await ta.patch('/api/v1/admin/organization', { localLogin: 'admins_only' })).status).toBe(204);
    expect(step(await steps(), 'local_login').state).toBe('done');
    expect((await ta.patch('/api/v1/admin/organization', { localLogin: 'allowed' })).status).toBe(204);
    expect(step(await steps(), 'local_login').state).toBe('done');

    // Repositories: a connected repository counts once a connection check recorded it.
    await inTenant(db, tenant, (trx) =>
      trx
        .insertInto('storage_repository')
        .values({ slug: 'sharepoint', name: 'SharePoint', adapter: 'm365', modes: ['pass_through'], config: JSON.stringify({}), connection_status: 'ok' })
        .execute(),
    );
    expect(shape(step(await steps(), 'repository'))).toEqual({ state: 'done', count: 1 });
    await inTenant(db, tenant, (trx) => trx.updateTable('storage_repository').set({ last_checked_at: new Date() }).where('slug', '=', 'sharepoint').execute());
    expect(shape(step(await steps(), 'repository'))).toEqual({ state: 'done', count: 2 });

    // Routing: an active rule; a pending one does not count.
    const vault = await inTenant(db, tenant, (trx) => trx.selectFrom('storage_repository').select('id').where('slug', '=', 'vault').executeTakeFirstOrThrow());
    await inTenant(db, tenant, (trx) =>
      trx.insertInto('storage_routing_rule').values({ storage_repository_id: vault.id, mode: 'stored', approval_status: 'pending_approval', requested_by: admin.id }).execute(),
    );
    expect(shape(step(await steps(), 'routing'))).toEqual({ state: 'pending', count: 0 });
    await inTenant(db, tenant, (trx) => trx.insertInto('storage_routing_rule').values({ storage_repository_id: vault.id, mode: 'stored' }).execute());
    expect(shape(step(await steps(), 'routing'))).toEqual({ state: 'done', count: 1 });
  });

  it('creates a system with one entry per catalogue item and leaf requirement row of the installed pack (D2-09)', async () => {
    const created = await ta.post('/api/v1/admin/management-systems', {
      slug: 'isms', code: 'ISMS', name: 'Information security', packId: 'ISO27001-2022', edition: '2022',
      scopeStatement: 'Head office', defaultRepository: 'vault', color: '#e8731a',
    });
    expect(created.status, created.text).toBe(201);
    msId = (created.body as { id: string }).id;

    // The expected count comes from the installed pack: catalogue items, plus requirement rows without a child row,
    // none of them retired.
    const expected = await sql<{ items: string; leaves: string }>`
      select (select count(*) from ref.catalogue_item c where c.framework_version_id = v.id and not c.retired) as items,
             (select count(*) from ref.requirement r where r.framework_version_id = v.id and not r.retired
                and not exists (select 1 from ref.requirement ch where ch.parent_id = r.id and not ch.retired)) as leaves
        from ref.framework_version v where v.pack_id = 'ISO27001-2022'`.execute(db.migrator);
    const items = Number(expected.rows[0]!.items);
    const leaves = Number(expected.rows[0]!.leaves);
    expect(items).toBeGreaterThan(0);
    expect(leaves).toBeGreaterThan(0);

    const entries = await inTenant(db, tenant, (trx) =>
      trx
        .selectFrom('applicability_entry')
        .select(['target_type', 'is_applicable', 'implementation_status', 'owner_user_id', 'deleted_at'])
        .where('management_system_id', '=', msId)
        .execute(),
    );
    expect(entries).toHaveLength(items + leaves);
    expect(entries.filter((e) => e.target_type === 'catalogue_item')).toHaveLength(items);
    expect(entries.filter((e) => e.target_type === 'requirement')).toHaveLength(leaves);
    expect(entries.every((e) => e.is_applicable && e.implementation_status === 'not_started' && e.owner_user_id === null && e.deleted_at === null)).toBe(true);
    // The readiness rows wait for readiness.recompute (queued 60 seconds later): null, shown as "Not computed yet" (D.6).
    const readiness = await inTenant(db, tenant, (trx) =>
      trx.selectFrom('clause_readiness').select(['clause_group', 'readiness_pct']).where('management_system_id', '=', msId).orderBy('clause_group').execute(),
    );
    expect(readiness).toEqual([4, 5, 6, 7, 8, 9, 10].map((group) => ({ clause_group: group, readiness_pct: null })));
    const seeded = await tenantAudit(db, tenant, 'applicability.seeded');
    expect(seeded).toEqual([
      expect.objectContaining({ management_system_id: msId, entity_id: msId, after_data: expect.objectContaining({ count: items + leaves, catalogueItems: items, requirements: leaves }) }),
    ]);

    const list = await steps();
    expect(shape(step(list, 'systems'))).toEqual({ state: 'done', count: 1 });
    expect(list.filter((s) => s.ms === 'isms').map((s) => [s.key, s.state, s.count ?? null])).toEqual([
      ['ms_manager', 'pending', null],
      ['verifiers', 'pending', 0],
      ['internal_auditor', 'optional', 0],
      ['implementing', 'pending', null],
      ['applicability', 'done', items + leaves],
      ['audit_dates', 'pending', 0],
    ]);
    expect(step(list, 'applicability', 'isms')).toMatchObject({ doneBy: 'ms_manager', assignee: null, screen: 'controls' });
    expect(step(list, 'audit_dates', 'isms')).toMatchObject({ doneBy: 'ms_manager', assignee: null, screen: 'timeline' });
    // The per-system steps come after the organisation steps and before pending grants.
    expect(list.map((s) => s.key).slice(-7)).toEqual(['ms_manager', 'verifiers', 'internal_auditor', 'implementing', 'applicability', 'audit_dates', 'pending_grants']);
  });

  it('completes the steps of a system: manager, verifiers, internal auditor, implementing, audit dates; team and pending grants', async () => {
    const manager = await addPerson(db, 'fresh.manager', [{ org: tenant }]);
    const owner = await addPerson(db, 'fresh.sponsor', [{ org: tenant }]);
    const expiredOwner = await addPerson(db, 'fresh.former', [{ org: tenant }]);
    const auditor = await addPerson(db, 'fresh.auditor', [{ org: tenant }]);
    const leaver = await addPerson(db, 'fresh.leaver', [{ org: tenant, status: 'disabled' }]);

    // A manager that is not primary is not the assignee.
    await grantRole(db, tenant, msId, manager.id, 'ms_manager');
    let list = await steps();
    expect(step(list, 'ms_manager', 'isms').state).toBe('pending');
    expect(shape(step(list, 'verifiers', 'isms'))).toEqual({ state: 'pending', count: 1 });
    await inTenant(db, tenant, (trx) => trx.updateTable('user_ms_role').set({ is_primary: true }).where('user_id', '=', manager.id).execute());
    list = await steps();
    expect(step(list, 'ms_manager', 'isms').state).toBe('done');
    const assignee = { name: manager.displayName, email: manager.email };
    expect(step(list, 'applicability', 'isms').assignee).toEqual(assignee);
    expect(step(list, 'audit_dates', 'isms').assignee).toEqual(assignee);

    // Verifiers: people with applicability.verify (MS Manager, Programme Owner); expired grants and disabled
    // members do not count.
    await grantRole(db, tenant, msId, expiredOwner.id, 'programme_owner', { validUntil: new Date(Date.now() - 86_400_000) });
    await grantRole(db, tenant, msId, leaver.id, 'programme_owner');
    expect(shape(step(await steps(), 'verifiers', 'isms'))).toEqual({ state: 'pending', count: 1 });
    await grantRole(db, tenant, msId, owner.id, 'programme_owner');
    expect(shape(step(await steps(), 'verifiers', 'isms'))).toEqual({ state: 'done', count: 2 });

    // Internal auditor: optional until one is granted.
    await grantRole(db, tenant, msId, auditor.id, 'internal_auditor');
    expect(shape(step(await steps(), 'internal_auditor', 'isms'))).toEqual({ state: 'done', count: 1 });

    // Implementing: the system moves on.
    const moved = await ta.patch(`/api/v1/admin/management-systems/${msId}`, { status: 'implementing' });
    expect(moved.status, moved.text).toBe(200);
    expect(step(await steps(), 'implementing', 'isms').state).toBe('done');

    // Audit dates: Stage 1 and Stage 2 planned.
    const event = (type: 'stage1' | 'stage2', day: string) =>
      inTenant(db, tenant, (trx) =>
        trx
          .insertInto('audit_event')
          .values({ management_system_id: msId, event_type: type, name_en: type, name_id: type, short_label: type, scheduled_at: day })
          .execute(),
      );
    await event('stage1', '2027-02-01');
    expect(shape(step(await steps(), 'audit_dates', 'isms'))).toEqual({ state: 'pending', count: 1 });
    await event('stage2', '2027-03-15');
    expect(shape(step(await steps(), 'audit_dates', 'isms'))).toEqual({ state: 'done', count: 2 });

    // Team: active people without an administrator role (the disabled member does not count).
    list = await steps();
    expect(shape(step(list, 'team'))).toEqual({ state: 'done', count: 4 });

    // Pending grants: a grant waiting for a second Tenant Admin.
    const pending = await addPerson(db, 'fresh.pending', [{ org: tenant }]);
    await grantRole(db, tenant, msId, pending.id, 'domain_owner', { approval: 'pending_approval', requestedBy: admin.id });
    list = await steps();
    expect(shape(step(list, 'pending_grants'))).toEqual({ state: 'pending', count: 1 });
    expect(list.filter((s) => s.state === 'pending').map((s) => s.key)).toEqual(['pending_grants']);
  });

  it('answers the Tenant Admin only (ms.admin) and lists no system that is archived', async () => {
    const manager = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('handle', '=', 'fresh.manager').executeTakeFirstOrThrow());
    const mm = await sessionIn(full, manager.id, tenant);
    expect((await mm.get('/api/v1/admin/onboarding')).status).toBe(403);
    await inTenant(db, tenant, (trx) => trx.updateTable('management_system').set({ status: 'archived' }).where('id', '=', msId).execute());
    const list = await steps();
    expect(list.some((s) => s.ms === 'isms')).toBe(false);
    expect(shape(step(list, 'systems'))).toEqual({ state: 'pending', count: 0 });
  });
});
