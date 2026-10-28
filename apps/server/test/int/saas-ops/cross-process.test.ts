// A status change seen by the other processes (Milestone 2 K.6, M2-S09): two api applications and a worker
// application on one database stand for three processes. The change made in the first api sends the change notice
// `mscd_tenant_changed` (M2-S10); the second api and the worker drop the organisation they cached within 2 seconds,
// so an offboarding organisation is read-only there at once instead of after the 60 second expiry. The scheduler of
// the worker plans no daily runs for a suspended organisation and plans them again once it is active.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { TENANT_CACHE_TTL_MS, TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { SchedulerTickJob } from '../../../src/modules/jobs/scheduler-tick.job';
import { TenantChangeListener } from '../../../src/modules/license/tenant-change';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import type { FullApp } from '../contract/harness';
import { createJobsApp, waitFor, type JobsApp } from '../jobs/helpers';
import { addPerson, createOnboardingApp, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import { MULTI, PLANS, problemType, setStatus } from './helpers';

describe('status changes across processes (Milestone 2 K.6, M2-S09)', () => {
  const db = useTestDatabase('empty');
  let first: FullApp;
  let second: FullApp;
  let worker: JobsApp;
  let op: Client;
  let gamma: CreatedTenant;
  let admin: Person;

  beforeAll(async () => {
    gamma = await createTenant(db, 'gamma', { name: 'PT Gamma' });
    admin = await addPerson(db, 'gamma.admin', [{ org: gamma, adminRoles: ['tenant_admin'] }], { password: true });
    const operator = await addPerson(db, 'ops.cross', [], { platformOperator: true, password: true });
    first = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
    second = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
    worker = await createJobsApp(db, { queues: ['scheduler.tick'], env: { ...MULTI } });
    await first.get<TenantChangeListener>(TenantChangeListener).ready();
    await second.get<TenantChangeListener>(TenantChangeListener).ready();
    await worker.moduleRef.get(TenantChangeListener).ready();
    op = await sessionIn(first, operator.id, null);
  });
  afterAll(async () => {
    await worker?.close();
    await second?.close();
    await first?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('listens for change notices in every api and worker process of multi tenancy', () => {
    expect(first.get<TenantChangeListener>(TenantChangeListener).connected).toBe(true);
    expect(second.get<TenantChangeListener>(TenantChangeListener).connected).toBe(true);
    expect(worker.moduleRef.get(TenantChangeListener).connected).toBe(true);
    expect(TENANT_CACHE_TTL_MS).toBe(60_000);
  });

  it('shows the new status in a second api process and in the worker within 2 seconds', async () => {
    const resolver = second.get<TenantResolver>(TenantResolver);
    const workerResolver = worker.moduleRef.get(TenantResolver);
    // Both processes hold the organisation as active in their cache.
    expect((await resolver.resolveById(gamma.id))?.status).toBe('active');
    expect((await workerResolver.resolveById(gamma.id))?.status).toBe('active');
    const ta = await sessionIn(second, admin.id, gamma);
    expect((await ta.get('/api/v1/admin/organization')).status).toBe(200);

    const started = Date.now();
    const call = await setStatus(op, 'gamma', { status: 'offboarding', reason: 'Contract ended on 30 Sep 2026', confirmSlug: 'gamma' });
    expect(call.status, call.text).toBe(200);
    await waitFor(async () => (await resolver.resolveById(gamma.id))?.status === 'offboarding', 2_000);
    await waitFor(async () => (await workerResolver.resolveById(gamma.id))?.status === 'offboarding', 2_000);
    expect(Date.now() - started).toBeLessThan(2_000 + 1_000);

    // The second process answers as an offboarding organisation: reads work, writes are refused.
    expect((await ta.get('/api/v1/admin/organization')).status).toBe(200);
    const write = await ta.patch('/api/v1/admin/organization', { siteCount: 3 }, { 'if-match': '*' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ type: problemType('organisation-inactive') });

    // Back to active: the second process accepts writes again within 2 seconds.
    expect((await setStatus(op, 'gamma', { status: 'active', reason: 'Contract renewed' })).status).toBe(200);
    await waitFor(async () => (await resolver.resolveById(gamma.id))?.status === 'active', 2_000);
    const allowed = await ta.get<{ etag: string }>('/api/v1/admin/organization');
    const patched = await ta.patch('/api/v1/admin/organization', { siteCount: 3 }, { 'if-match': allowed.body.etag });
    expect(patched.status, patched.text).toBe(204);
  });

  it('does not cache a row read while a change notice arrived', async () => {
    // A stand-in database whose reads finish when the test says so.
    const reads: ((row: unknown) => void)[] = [];
    const chain = {
      selectFrom: () => chain,
      select: () => chain,
      where: () => chain,
      executeTakeFirst: () => new Promise((resolve) => reads.push(resolve)),
    };
    const resolver = new TenantResolver(chain as never);
    const row = (status: string) => ({
      id: gamma.id, slug: 'gamma', name: 'PT Gamma', schema_name: 'org_gamma', status, time_zone: 'Asia/Jakarta',
      local_login: 'allowed', demo_deploy_label: null, site_count: 1, position: 0,
    });
    const first = resolver.resolveById(gamma.id);
    // The notice of a change arrives while the first read is under way.
    resolver.invalidate(gamma.id);
    reads.shift()!(row('active'));
    expect((await first)?.status).toBe('active');
    // That read was not kept: the next call reads again and keeps the new value.
    const second = resolver.resolveById(gamma.id);
    expect(reads).toHaveLength(1);
    reads.shift()!(row('suspended'));
    expect((await second)?.status).toBe('suspended');
    expect((await resolver.resolveById(gamma.id))?.status).toBe('suspended');
    expect(reads).toHaveLength(0);
  });

  it('plans no daily jobs for a suspended organisation, and plans them again when it is active', async () => {
    const other = await createTenant(db, 'still_active', { name: 'Still Active' });
    const tick = worker.moduleRef.get(SchedulerTickJob);
    expect((await setStatus(op, 'gamma', { status: 'suspended', reason: 'Invoice overdue by 60 days' })).status).toBe(200);

    // 2030-01-15 17:05 UTC is 00:05 on 16 January in Jakarta: the jobs of that hour are due for both organisations.
    worker.setNow('2030-01-15T17:05:00Z');
    const suspended = await tick.tick();
    expect(suspended.enqueued.filter((run) => run.orgId === gamma.id)).toEqual([]);
    expect(suspended.enqueued.filter((run) => run.orgId === other.id).map((run) => run.name).sort()).toEqual(['audit-prep.generate', 'license.check', 'tasks.overdue']);
    expect(worker.queue.waitingJobs().filter((job) => job.env.orgId === gamma.id)).toEqual([]);

    expect((await setStatus(op, 'gamma', { status: 'active', reason: 'Invoice paid' })).status).toBe(200);
    worker.setNow('2030-01-15T17:20:00Z');
    const active = await tick.tick();
    expect(active.enqueued.filter((run) => run.orgId === gamma.id).map((run) => run.name).sort()).toEqual(['audit-prep.generate', 'license.check', 'tasks.overdue']);
    expect(active.enqueued.filter((run) => run.orgId === other.id)).toEqual([]);
  });
});
