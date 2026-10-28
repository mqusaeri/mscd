// Per-organisation entitlements (Milestone 2 D.1, K.6, M2-S10) in multi tenancy: the operator routes
// `ops.plans.list`, `ops.entitlements.get` and `ops.entitlements.set` (preset and explicit limits, If-Match with 428
// and 412, one audit entry with the old and new values), the limits of each organisation enforced through its own row
// (a second organisation unchanged), a lowered limit accepted with a warning and then blocking invitations, the
// signed licence upload writing the row (source `signed_licence`), the row of a signed licence installed before
// M2-S10 written once on the first read, `applyPreset` for M2-S09, the presets of `saas.yaml`, and 409
// `single_tenancy` in single tenancy.
import path from 'node:path';
import { API_ROUTES, Entitlement, EntitlementSetResult, PlanPreset, type LicenceView } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LICENCE_GATE, type LicenceGate } from '../../../src/common/tokens';
import { loadProfile } from '../../../src/config/load-profile';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { EntitlementService } from '../../../src/modules/license/entitlement.service';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, createFullApp, type FullApp } from '../contract/harness';
import { addPerson, createOnboardingApp, inPlatform, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import { devLicence } from '../packs/fixtures';
import { MULTI, PLANS, entitlementAudit, entitlementRow, storeOldLicence } from './helpers';

const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
const GET = route('ops.entitlements.get');
const SET = route('ops.entitlements.set');
const PLANS_LIST = route('ops.plans.list');
const INVITE = route('admin.users.create');
const LICENCE = route('license.get');
const TODAY = '2026-09-29'; // `demo.fixed_today` of the test profile

/** Explicit limits of `ops.entitlements.set`. */
const limits = (extra: Record<string, unknown> = {}) => ({
  plan: 'custom',
  maxUsers: 20,
  maxManagementSystems: 2,
  frameworks: ['ISO27001'],
  storageAdapters: ['managed_vault'],
  features: ['link_health_monitor'],
  rateUserPerMinute: null,
  rateOrgPerMinute: null,
  graceDays: 14,
  validFrom: '2026-09-01',
  validUntil: '2027-08-31',
  ...extra,
});

describe('per-organisation entitlements in multi tenancy (Milestone 2 M2-S10)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let operator: Person;
  let op: Client;
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let alphaAdmin: Person;
  let betaAdmin: Person;
  let alphaTa: Client;
  let betaTa: Client;

  const get = (client: Client, org: string) => callRoute<Entitlement>(client, GET, { params: { org } });
  const set = (client: Client, org: string, body: unknown, ifMatch?: string) =>
    callRoute<EntitlementSetResult>(client, SET, { params: { org }, body, ...(ifMatch !== undefined ? { headers: { 'if-match': ifMatch } } : {}) });
  const invite = (client: Client, handle: string) =>
    callRoute(client, INVITE, { body: { email: `${handle}@entitlements.test`, displayName: `Person ${handle}`, adminRoles: [] } });

  beforeAll(async () => {
    alpha = await createTenant(db, 'alpha', { name: 'PT Alpha' });
    beta = await createTenant(db, 'beta', { name: 'PT Beta' });
    alphaAdmin = await addPerson(db, 'alpha.admin', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true });
    betaAdmin = await addPerson(db, 'beta.admin', [{ org: beta, adminRoles: ['tenant_admin'] }], { password: true });
    operator = await addPerson(db, 'ops.entitlements', [], { platformOperator: true, password: true });
    full = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
    op = await sessionIn(full, operator.id, null);
    alphaTa = await sessionIn(full, alphaAdmin.id, alpha);
    betaTa = await sessionIn(full, betaAdmin.id, beta);
  });
  afterAll(async () => {
    await full?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('lists the plan presets of license.plans, sorted by name', async () => {
    const call = await callRoute<PlanPreset[]>(op, PLANS_LIST, {});
    expect(call.violations).toEqual([]);
    expect(call.status).toBe(200);
    expect(call.body).toEqual([
      {
        name: 'standard',
        maxUsers: 50,
        maxManagementSystems: 3,
        frameworks: [],
        storageAdapters: ['managed_vault', 'm365', 'google_drive'],
        features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
        rateUserPerMinute: null,
        rateOrgPerMinute: null,
        graceDays: 30,
        validDays: 365,
      },
      {
        name: 'trial',
        maxUsers: 3,
        maxManagementSystems: 1,
        frameworks: [],
        storageAdapters: ['managed_vault'],
        features: ['link_health_monitor'],
        rateUserPerMinute: null,
        rateOrgPerMinute: null,
        graceDays: 7,
        validDays: 30,
      },
    ]);
    // A Tenant Admin is no operator (F.6: ops.read is a platform permission).
    expect((await callRoute(alphaTa, PLANS_LIST, {})).status).toBe(403);
  });

  it('ships the D-S4 presets trial and standard in saas.yaml', () => {
    const { profile } = loadProfile({ env: { MSCD_PROFILE_FILE: path.resolve(__dirname, '../../../profiles/saas.yaml') }, flavor: 'dev' });
    expect(Object.keys(profile.license.plans).sort()).toEqual(['standard', 'trial']);
    expect(profile.license.plans.trial).toMatchObject({ max_users: 10, max_management_systems: 1, valid_days: 30, frameworks: [] });
    expect(profile.license.plans.standard).toMatchObject({ max_users: 50, max_management_systems: 3, valid_days: 365, frameworks: [] });
  });

  it('answers 404 for an organisation without an entitlement and for an unknown organisation', async () => {
    const none = await get(op, 'beta');
    expect(none.violations).toEqual([]);
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ messageKey: 'no_entitlement' });
    const unknown = await get(op, 'nosuchorg');
    expect(unknown.status).toBe(404);
    expect(await entitlementRow(db, beta.id)).toBeNull();
  });

  it('sets a preset with If-Match (428 without it, 412 when stale), audits the old and new values and sends the ETag', async () => {
    const missing = await set(op, 'alpha', { preset: 'trial' });
    expect(missing.violations).toEqual([]);
    expect(missing.status).toBe(428);
    expect(missing.body).toMatchObject({ messageKey: 'if_match_required', status: 428 });
    const stale = await set(op, 'alpha', { preset: 'trial' }, 'W/"1-1700000000000"');
    expect(stale.violations).toEqual([]);
    expect(stale.status).toBe(412);
    expect(await entitlementRow(db, alpha.id)).toBeNull();
    expect(await entitlementAudit(db, alpha.id)).toEqual([]);

    // `*` creates the row of an organisation that has none.
    const created = await set(op, 'alpha', { preset: 'trial' }, '*');
    expect(created.violations).toEqual([]);
    expect(created.status, created.text).toBe(200);
    expect(created.body.warnings).toBeUndefined();
    expect(created.body.data).toEqual({
      organization: 'alpha',
      plan: 'trial',
      source: 'preset',
      maxUsers: 3,
      maxManagementSystems: 1,
      frameworks: [],
      storageAdapters: ['managed_vault'],
      features: ['link_health_monitor'],
      rateUserPerMinute: null,
      rateOrgPerMinute: null,
      graceDays: 7,
      validFrom: TODAY,
      validUntil: '2026-10-28',
      version: 1,
      updatedAt: expect.any(String),
      usage: { users: 1, managementSystems: 0 },
    });
    const etag = String(created.headers.etag);
    expect(etag).toMatch(/^W\/"1-\d+"$/);
    expect(await entitlementRow(db, alpha.id)).toMatchObject({ plan: 'trial', source: 'preset', max_users: 3, version: 1, updated_by: operator.id });
    const [first, ...rest] = await entitlementAudit(db, alpha.id);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      actor_kind: 'operator',
      actor_user_id: operator.id,
      entity_type: 'entitlement',
      entity_id: alpha.id,
      entity_code: 'alpha',
      before_data: null,
      after_data: expect.objectContaining({ plan: 'trial', source: 'preset', maxUsers: 3, validUntil: '2026-10-28', version: 1, reason: 'preset' }),
    });

    // The read sends the same ETag; the Tenant Admin cannot read it (F.6).
    const read = await get(op, 'alpha');
    expect(read.violations).toEqual([]);
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe(etag);
    expect(read.body).toEqual(created.body.data);
    expect((await get(alphaTa, 'alpha')).status).toBe(403);

    // Explicit limits with the ETag: version 2, one more entry with the changed values before and after.
    const changed = await set(op, 'alpha', limits(), etag);
    expect(changed.violations).toEqual([]);
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.data).toMatchObject({ plan: 'custom', source: 'manual', maxUsers: 20, maxManagementSystems: 2, frameworks: ['ISO27001'], version: 2 });
    const etag2 = String(changed.headers.etag);
    expect(etag2).not.toBe(etag);
    const audit = await entitlementAudit(db, alpha.id);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      actor_kind: 'operator',
      before_data: expect.objectContaining({ plan: 'trial', source: 'preset', maxUsers: 3, version: 1 }),
      after_data: expect.objectContaining({ plan: 'custom', source: 'manual', maxUsers: 20, version: 2, reason: 'limits' }),
    });

    // The old ETag is stale now; the same values again change nothing and write no entry.
    expect((await set(op, 'alpha', { preset: 'standard' }, etag)).status).toBe(412);
    const same = await set(op, 'alpha', limits(), etag2);
    expect(same.status).toBe(200);
    expect(same.body.data.version).toBe(2);
    expect(same.headers.etag).toBe(etag2);
    expect(await entitlementAudit(db, alpha.id)).toHaveLength(2);

    // An unknown preset (422) and an end before the start (400) write nothing.
    const unknown = await set(op, 'alpha', { preset: 'gold' }, '*');
    expect(unknown.violations).toEqual([]);
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ messageKey: 'unknown_preset' });
    const backwards = await set(op, 'alpha', limits({ validFrom: '2027-01-01', validUntil: '2026-12-31' }), '*');
    expect(backwards.violations).toEqual([]);
    expect(backwards.status).toBe(400);
    expect((await entitlementRow(db, alpha.id))?.version).toBe(2);
    // The Tenant Admin cannot change it (ops.entitlements.manage is the operator's).
    expect((await set(alphaTa, 'alpha', { preset: 'standard' }, '*')).status).toBe(403);
    // Nothing was written for the other organisation.
    expect(await entitlementRow(db, beta.id)).toBeNull();
  });

  it('enforces the limits of each organisation; a lowered limit is accepted with a warning and stops invitations', async () => {
    // Beta gets the standard preset, Alpha explicit limits with one more user than it has.
    expect((await set(op, 'beta', { preset: 'standard' }, '*')).status).toBe(200);
    expect((await set(op, 'alpha', limits({ maxUsers: 2 }), '*')).status).toBe(200);
    const alphaMember = await addPerson(db, 'alpha.member', [{ org: alpha }]);
    expect(alphaMember.id).toBeDefined();

    // Alpha has 2 active members and may have 2: the invitation stops with the plan message of LIC-USERS.
    const refused = await invite(alphaTa, 'alpha.third');
    expect(refused.violations).toEqual([]);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ rule: 'LIC-USERS', messageKey: 'licence.max_users' });
    expect((refused.body as { messages: { en: string } }).messages.en).toContain('The plan of this organisation allows 2 active users');
    // Beta keeps its own limits.
    const allowed = await invite(betaTa, 'beta.second');
    expect(allowed.violations).toEqual([]);
    expect(allowed.status).toBe(202);

    // Raised to 5: the invitation goes through. Lowered to 1, below the 2 active members: accepted with a warning.
    expect((await set(op, 'alpha', limits({ maxUsers: 5 }), '*')).status).toBe(200);
    expect((await invite(alphaTa, 'alpha.fourth')).status).toBe(202);
    const lowered = await set(op, 'alpha', limits({ maxUsers: 1, maxManagementSystems: 0 }), '*');
    expect(lowered.violations).toEqual([]);
    expect(lowered.status).toBe(200);
    expect(lowered.body.data.usage).toEqual({ users: 2, managementSystems: 0 });
    expect(lowered.body.warnings?.map((w) => w.rule)).toEqual(['LIC-USERS']);
    expect(lowered.body.warnings?.[0]?.messages.en).toContain('Nobody loses access');
    const blocked = await invite(alphaTa, 'alpha.fifth');
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ rule: 'LIC-USERS' });
    // The members keep their access.
    expect((await alphaTa.get('/api/v1/me')).status).toBe(200);

    // Management systems: Alpha may have none now, Beta three (the gate under its lock, D-15).
    const gate = full.get<LicenceGate>(LICENCE_GATE);
    const scope = full.get<TenantScope>(TenantScope);
    await expect(
      scope.withTenant({ orgId: alpha.id, schema: alpha.schemaName, userId: alphaAdmin.id }, (trx) => gate.assertCanAddMs(trx, alpha.id)),
    ).rejects.toMatchObject({ extras: { rule: 'LIC-MS', messageKey: 'licence.max_management_systems' } });
    await expect(
      scope.withTenant({ orgId: beta.id, schema: beta.schemaName, userId: betaAdmin.id }, (trx) => gate.assertCanAddMs(trx, beta.id)),
    ).resolves.toBeUndefined();

    // The licence view of a Tenant Admin shows the entitlement with its source and plan.
    const view = await callRoute<LicenceView>(betaTa, LICENCE, {});
    expect(view.violations).toEqual([]);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ source: 'preset', plan: 'standard', maxUsers: 50, maxManagementSystems: 3, state: 'valid', validFrom: TODAY, validUntil: '2027-09-28' });
  });

  it('writes the row with source signed_licence when the operator uploads a signed licence, keeping its rate limits', async () => {
    const gamma = await createTenant(db, 'gamma', { name: 'PT Gamma' });
    const gammaAdmin = await addPerson(db, 'gamma.admin', [{ org: gamma, adminRoles: ['tenant_admin'] }]);
    // Limits set before, with a rate limit per user, which a licence does not carry.
    expect((await set(op, 'gamma', limits({ rateUserPerMinute: 120 }), '*')).status).toBe(200);

    const uploaded = await op.put<LicenceView>('/api/v1/admin/license', { org: 'gamma', licence: devLicence(gamma.id, { max_users: 4 }) });
    expect(uploaded.status, uploaded.text).toBe(200);
    expect(uploaded.body).toMatchObject({ licenseId: 'LIC-TEST-0001', source: 'signed_licence', plan: null, maxUsers: 4, signature: { verified: true } });
    expect(await entitlementRow(db, gamma.id)).toMatchObject({
      source: 'signed_licence',
      plan: null,
      max_users: 4,
      max_management_systems: 10,
      frameworks: ['ISO22301', 'ISO27001', 'ISO37001', 'ISO9001'],
      valid_from: '2026-04-01',
      valid_until: '2027-03-31',
      grace_days: 30,
      rate_user_per_minute: 120,
      version: 2,
    });
    const audit = await entitlementAudit(db, gamma.id);
    expect(audit.map((a) => (a.after_data as { reason?: string }).reason)).toEqual(['limits', 'licence_upload']);
    expect(audit[1]).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id });

    // The operator route and the Tenant Admin's licence view read the row.
    const read = await get(op, 'gamma');
    expect(read.body).toMatchObject({ source: 'signed_licence', maxUsers: 4, rateUserPerMinute: 120, usage: { users: 1, managementSystems: 0 } });
    const ta = await sessionIn(full, gammaAdmin.id, gamma);
    expect((await callRoute<LicenceView>(ta, LICENCE, {})).body).toMatchObject({ licenseId: 'LIC-TEST-0001', source: 'signed_licence', maxUsers: 4 });

    // The same licence again changes nothing.
    expect((await op.put('/api/v1/admin/license', { org: 'gamma', licence: devLicence(gamma.id, { max_users: 4 }) })).status).toBe(200);
    expect((await entitlementRow(db, gamma.id))?.version).toBe(2);
  });

  it('gives an organisation with a signed licence installed before M2-S10 its row on the first read, once, and keeps its limits', async () => {
    const delta = await createTenant(db, 'delta', { name: 'PT Delta' });
    const deltaAdmin = await addPerson(db, 'delta.admin', [{ org: delta, adminRoles: ['tenant_admin'] }]);
    await addPerson(db, 'delta.member', [{ org: delta }]);
    await storeOldLicence(db, delta, { license_id: 'LIC-OLD-0007', max_users: 2 });
    expect(await entitlementRow(db, delta.id)).toBeNull();

    // The first read (the Tenant Admin's licence view) writes the row from the licence.
    const ta = await sessionIn(full, deltaAdmin.id, delta);
    const view = await callRoute<LicenceView>(ta, LICENCE, {});
    expect(view.status, view.text).toBe(200);
    expect(view.body).toMatchObject({ licenseId: 'LIC-OLD-0007', source: 'signed_licence', maxUsers: 2, state: 'valid' });
    expect(await entitlementRow(db, delta.id)).toMatchObject({
      source: 'signed_licence',
      plan: null,
      max_users: 2,
      max_management_systems: 10,
      valid_until: '2027-03-31',
      rate_user_per_minute: null,
      version: 1,
      updated_by: null,
    });
    const audit = await entitlementAudit(db, delta.id);
    expect(audit).toEqual([
      expect.objectContaining({ actor_kind: 'system', entity_code: 'delta', before_data: null, after_data: expect.objectContaining({ source: 'signed_licence', maxUsers: 2, reason: 'backfill' }) }),
    ]);

    // Later reads, the operator's among them, write nothing more; the limits of the licence hold.
    expect((await get(op, 'delta')).body).toMatchObject({ source: 'signed_licence', maxUsers: 2, usage: { users: 2, managementSystems: 0 } });
    expect((await callRoute(ta, LICENCE, {})).status).toBe(200);
    expect(await entitlementAudit(db, delta.id)).toHaveLength(1);
    const refused = await invite(ta, 'delta.third');
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ rule: 'LIC-USERS' });
  });

  it('writes no row from a stored licence that does not verify, which keeps the organisation read-only as before', async () => {
    const epsilon = await createTenant(db, 'epsilon', { name: 'PT Epsilon' });
    const epsilonAdmin = await addPerson(db, 'epsilon.admin', [{ org: epsilon, adminRoles: ['tenant_admin'] }]);
    // A licence bound to another organisation does not verify for this one.
    await storeOldLicence(db, epsilon, {}, devLicence(alpha.id));
    const ta = await sessionIn(full, epsilonAdmin.id, epsilon);
    const view = await callRoute<LicenceView>(ta, LICENCE, {});
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ state: 'read_only', signature: { verified: false } });
    expect(view.body.source).toBeUndefined();
    expect(await entitlementRow(db, epsilon.id)).toBeNull();
    expect(await entitlementAudit(db, epsilon.id)).toEqual([]);
  });

  it('writes the row of a preset with applyPreset in the caller transaction (M2-S09), once', async () => {
    const zeta = await createTenant(db, 'zeta', { name: 'PT Zeta' });
    const service = full.get<EntitlementService>(EntitlementService);
    const scope = full.get<TenantScope>(TenantScope);
    const row = await scope.withPlatform((trx) => service.applyPreset(trx, zeta.id, 'standard', { actor: { userId: operator.id, kind: 'operator' }, slug: 'zeta' }), { scope: 'operator' });
    expect(row).toMatchObject({ organizationId: zeta.id, plan: 'standard', source: 'preset', maxUsers: 50, validFrom: TODAY, validUntil: '2027-09-28', version: 1 });
    // Again: nothing changes, nothing is audited twice.
    const again = await scope.withPlatform((trx) => service.applyPreset(trx, zeta.id, 'standard', { slug: 'zeta' }), { scope: 'operator' });
    expect(again.version).toBe(1);
    expect(await entitlementAudit(db, zeta.id)).toEqual([expect.objectContaining({ actor_kind: 'operator', actor_user_id: operator.id, entity_code: 'zeta' })]);
    await expect(scope.withPlatform((trx) => service.applyPreset(trx, zeta.id, 'gold'), { scope: 'operator' })).rejects.toMatchObject({ extras: { messageKey: 'unknown_preset' } });
  });
});

describe('entitlements in single tenancy (Milestone 2 J.6)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let op: Client;

  beforeAll(async () => {
    await createTenant(db, 'solo', { name: 'PT Solo' });
    const operator = await addPerson(db, 'ops.single', [], { platformOperator: true, password: true });
    full = await createFullApp(db, { ...PLANS });
    op = await sessionIn(full, operator.id, null);
  });
  afterAll(async () => {
    await full?.close();
  });

  it('answers 409 single_tenancy on every entitlement route and writes nothing', async () => {
    for (const [def, input] of [
      [PLANS_LIST, {}],
      [GET, { params: { org: 'solo' } }],
      [SET, { params: { org: 'solo' }, body: { preset: 'trial' }, headers: { 'if-match': '*' } }],
    ] as const) {
      const call = await callRoute(op, def, input);
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(409);
      expect(call.body).toMatchObject({ messageKey: 'single_tenancy' });
    }
    const rows = await inPlatform(db, (trx) => trx.selectFrom('platform.entitlement').select('organization_id').execute());
    expect(rows).toEqual([]);
  });
});
