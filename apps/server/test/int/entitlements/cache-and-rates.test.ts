// The entitlement cache across processes and the rate limits per organisation (Milestone 2 K.6, M2-S10): two api
// applications on one database stand for two processes. A change in one drops the cached row in the other through
// `NOTIFY mscd_tenant_changed` within 2 seconds; a change without a notice counts after at most 60 seconds; a lost
// listening connection drops every entry once it is back. The per-user and per-organisation limits of every api
// request come from the entitlement (429 at the new value), with the defaults where it sets none.
import { API_ROUTES } from '@mscd/shared';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LICENCE_GATE, type LicenceGate } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { ENTITLEMENT_CACHE_TTL_MS, EntitlementRegistry } from '../../../src/modules/license/entitlement-registry';
import { TENANT_CHANGED_CHANNEL, TenantChangeListener } from '../../../src/modules/license/tenant-change';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { waitFor } from '../jobs/helpers';
import { addPerson, createOnboardingApp, inPlatform, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import { MULTI, PLANS } from './helpers';

const SET = API_ROUTES.find((r) => r.id === 'ops.entitlements.set')!;

/** Resolves when `listener` hands on the change notice of `orgId` (or a notice for every organisation). */
function nextNotice(listener: TenantChangeListener, orgId: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`No change notice for ${orgId} within ${timeoutMs} ms`));
    }, timeoutMs);
    const stop = listener.subscribe((changed) => {
      if (changed !== null && changed !== orgId) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

const limits = (extra: Record<string, unknown> = {}) => ({
  maxUsers: 20,
  maxManagementSystems: 2,
  frameworks: [],
  storageAdapters: ['managed_vault'],
  features: [],
  rateUserPerMinute: null,
  rateOrgPerMinute: null,
  graceDays: 30,
  validFrom: '2026-01-01',
  validUntil: '2027-12-31',
  ...extra,
});

describe('entitlement cache across processes and rate limits per organisation (Milestone 2 M2-S10)', () => {
  const db = useTestDatabase('empty');
  let first: FullApp;
  let second: FullApp;
  let op: Client;
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let alphaAdmin: Person;
  let alphaMember: Person;
  let betaAdmin: Person;

  const setLimits = async (org: string, extra: Record<string, unknown> = {}) => {
    const call = await callRoute(op, SET, { params: { org }, body: limits(extra), headers: { 'if-match': '*' } });
    expect(call.violations).toEqual([]);
    expect(call.status, call.text).toBe(200);
    return call;
  };

  beforeAll(async () => {
    alpha = await createTenant(db, 'alpha', { name: 'PT Alpha' });
    beta = await createTenant(db, 'beta', { name: 'PT Beta' });
    alphaAdmin = await addPerson(db, 'alpha.admin', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true });
    alphaMember = await addPerson(db, 'alpha.member', [{ org: alpha }], { password: true });
    betaAdmin = await addPerson(db, 'beta.admin', [{ org: beta, adminRoles: ['tenant_admin'] }], { password: true });
    const operator = await addPerson(db, 'ops.cache', [], { platformOperator: true, password: true });
    first = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
    second = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
    await first.get<TenantChangeListener>(TenantChangeListener).ready();
    await second.get<TenantChangeListener>(TenantChangeListener).ready();
    op = await sessionIn(first, operator.id, null);
  });
  afterAll(async () => {
    await second?.close();
    await first?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  describe('the cache of the other process', () => {
    it('listens on the change channel in api processes of multi tenancy', () => {
      expect(TENANT_CHANGED_CHANNEL).toBe('mscd_tenant_changed');
      expect(first.get<TenantChangeListener>(TenantChangeListener).connected).toBe(true);
      expect(second.get<TenantChangeListener>(TenantChangeListener).connected).toBe(true);
    });

    it('drops the cached row within 2 seconds of a change in another process', async () => {
      const listener = second.get<TenantChangeListener>(TenantChangeListener);
      const registry = second.get<EntitlementRegistry>(EntitlementRegistry);
      // The notices of these writes reach the other process before it reads.
      let seen = nextNotice(listener, alpha.id);
      await setLimits('alpha', { maxUsers: 20 });
      await seen;
      seen = nextNotice(listener, beta.id);
      await setLimits('beta', { maxUsers: 9 });
      await seen;
      const cached = await registry.get(alpha.id);
      expect(cached).toMatchObject({ maxUsers: 20 });
      expect(registry.peek(alpha.id)).toBe(cached);
      expect(await registry.get(beta.id)).toMatchObject({ maxUsers: 9 });

      const started = Date.now();
      await setLimits('alpha', { maxUsers: 21 });
      await waitFor(() => registry.peek(alpha.id) === undefined, 2_000);
      expect(Date.now() - started).toBeLessThan(2_000);
      // Another organisation's entry stays.
      expect(registry.peek(beta.id)).toMatchObject({ maxUsers: 9 });
      expect(await registry.get(alpha.id)).toMatchObject({ maxUsers: 21 });
    });

    it('makes an organisation read-only in the other process once its entitlement ended past grace', async () => {
      const gate = second.get<LicenceGate>(LICENCE_GATE);
      await setLimits('alpha', {});
      await expect(gate.assertWritable(alpha.id)).resolves.toBeUndefined();
      await setLimits('alpha', { validFrom: '2025-01-01', validUntil: '2025-06-30', graceDays: 0 });
      await waitFor(async () => {
        try {
          await gate.assertWritable(alpha.id);
          return false;
        } catch (error) {
          return (error as { slug?: string }).slug === 'read-only-mode';
        }
      }, 2_000);
      // A write request in the other process is refused, a read still answers.
      const ta = await sessionIn(second, alphaAdmin.id, alpha);
      const write = await ta.post('/api/v1/admin/users', { email: 'late@alpha.test', displayName: 'Late', adminRoles: [] });
      expect(write.status).toBe(403);
      expect(write.body).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/read-only-mode' });
      expect((await ta.get('/api/v1/me')).status).toBe(200);
      await setLimits('alpha', {});
    });

    it('reads a row changed without a notice again after at most 60 seconds', async () => {
      const registry = second.get<EntitlementRegistry>(EntitlementRegistry);
      const seen = nextNotice(second.get<TenantChangeListener>(TenantChangeListener), alpha.id);
      await setLimits('alpha', { maxUsers: 30 });
      await seen;
      expect((await registry.get(alpha.id))?.maxUsers).toBe(30);
      // A change straight in the database sends no notice.
      await inPlatform(db, (trx) => sql`update platform.entitlement set max_users = 31 where organization_id = ${alpha.id}`.execute(trx));
      expect((await registry.get(alpha.id))?.maxUsers).toBe(30);
      const realNow = registry.now;
      try {
        registry.now = () => Date.now() + ENTITLEMENT_CACHE_TTL_MS + 1_000;
        expect((await registry.get(alpha.id))?.maxUsers).toBe(31);
      } finally {
        registry.now = realNow;
      }
      registry.invalidate(null);
    });

    it('drops every entry after the listening connection was lost and is back', async () => {
      const registry = second.get<EntitlementRegistry>(EntitlementRegistry);
      const listener = second.get<TenantChangeListener>(TenantChangeListener);
      await registry.get(alpha.id);
      await registry.get(beta.id);
      expect(registry.peek(alpha.id)).toBeDefined();
      const admin = new pg.Client({ connectionString: db.urls.admin });
      await admin.connect();
      try {
        const killed = await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'mscd-api-tenant-changes'`,
        );
        expect(killed.rowCount).toBeGreaterThanOrEqual(2);
      } finally {
        await admin.end();
      }
      await waitFor(() => registry.peek(alpha.id) === undefined && registry.peek(beta.id) === undefined && listener.connected, 10_000);
      // Back on the channel: a change reaches it again.
      await registry.get(alpha.id);
      await first.get<TenantChangeListener>(TenantChangeListener).ready();
      await waitFor(() => first.get<TenantChangeListener>(TenantChangeListener).connected, 10_000);
      await setLimits('alpha', { maxUsers: 32 });
      await waitFor(() => registry.peek(alpha.id) === undefined, 2_000);
    });
  });

  describe('rate limits per organisation', () => {
    let alphaTa: Client;
    let alphaUser: Client;
    let betaTa: Client;

    beforeAll(async () => {
      alphaTa = await sessionIn(first, alphaAdmin.id, alpha);
      alphaUser = await sessionIn(first, alphaMember.id, alpha);
      betaTa = await sessionIn(first, betaAdmin.id, beta);
    });

    it('answers 429 at the per-user limit of the entitlement and leaves the other organisation at the default', async () => {
      await setLimits('alpha', { rateUserPerMinute: 3 });
      await setLimits('beta', {});
      const answers: number[] = [];
      for (let i = 0; i < 4; i += 1) answers.push((await alphaTa.get('/api/v1/me')).status);
      expect(answers).toEqual([200, 200, 200, 429]);
      const refused = await alphaTa.get('/api/v1/me');
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ type: 'https://mscd.cyberlentera.com/problems/rate-limited' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Another user of the same organisation has a bucket of their own.
      const other = await alphaUser.get('/api/v1/me');
      expect(other.status).toBe(200);
      expect(other.headers['ratelimit-limit']).toBe('3');
      // The other organisation keeps the defaults of every api request (600 per user and minute).
      for (let i = 0; i < 5; i += 1) {
        const reply = await betaTa.get('/api/v1/me');
        expect(reply.status).toBe(200);
        expect(Number(reply.headers['ratelimit-limit'])).toBeGreaterThan(3);
      }
    });

    it('answers 429 at the per-organisation limit across its users, and returns to the defaults when the value is null', async () => {
      await setLimits('alpha', { rateOrgPerMinute: 4 });
      const answers: number[] = [];
      for (const client of [alphaTa, alphaUser, alphaTa, alphaUser, alphaTa]) answers.push((await client.get('/api/v1/me')).status);
      expect(answers).toEqual([200, 200, 200, 200, 429]);
      expect((await betaTa.get('/api/v1/me')).status).toBe(200);

      // Null again: the default limits count from the next request on.
      await setLimits('alpha', { rateOrgPerMinute: null, rateUserPerMinute: null });
      expect((await alphaTa.get('/api/v1/me')).status).toBe(200);
      expect((await alphaUser.get('/api/v1/me')).status).toBe(200);
    });
  });
});
