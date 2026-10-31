// Organisation settings (Milestone 2 D.1, D.2): `GET /admin/organization` (with the ETag of the organisation row) and
// `PATCH /admin/organization` with the name, the IANA time zone and the number of sites (one `org.updated` entry with
// before and after; the local sign-in policy keeps `org.settings_updated`; If-Match, 412 when stale), the row lock of
// the PATCH (`FOR NO KEY UPDATE`: an auditor access grant does not deadlock with it), and the run ledger of the daily
// jobs (risk table I): `scheduler.tick` writes a row per organisation, job and local date before it sends the job,
// and the job works on the date of its row whatever the time zone does before it starts; a send that pg-boss drops for
// a key `<prefix>:<org>:all` leaves no row, so a later tick sends the run. The pure planner and a randomised simulation
// of ticks and time zone changes are unit tests in test/unit/jobs/daily-run-planner.test.ts and
// daily-run-busy-queue.test.ts.
import { API_ROUTES, type OrganizationSettings } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Clock } from '../../../src/common/clock';
import type { JobHandlerRegistry } from '../../../src/common/jobs/job-handler';
import { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { PgBossJobQueue } from '../../../src/modules/jobs/pgboss-job-queue';
import { ensurePgBossSchema } from '../../../src/modules/jobs/pgboss-schema';
import { SchedulerTickJob, type TickRun } from '../../../src/modules/jobs/scheduler-tick.job';
import { TasksOverdueJob } from '../../../src/modules/jobs/tasks-overdue.job';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { expectPgError, inScope, rolledBack } from '../db/helpers';
import { createJobsApp, waitFor, type JobsApp } from '../jobs/helpers';
import { addPerson, createOnboardingApp, inPlatform, resetRateLimits, sessionIn, tenantAudit, type Client, type Person } from './helpers';

const GET = API_ROUTES.find((r) => r.id === 'admin.organization.get')!;
const PATCH = API_ROUTES.find((r) => r.id === 'admin.organization.update')!;

describe('organisation settings (Milestone 2 D.1, D.2)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let tenant: CreatedTenant;
  let admin: Person;
  let ta: Client;

  const settings = async (): Promise<OrganizationSettings> => {
    const call = await callRoute<OrganizationSettings>(ta, GET, {});
    expect(call.violations).toEqual([]);
    expect(call.status).toBe(200);
    return call.body;
  };
  const patch = async (body: unknown, client: Client = ta, headers: Record<string, string> = {}) => {
    await resetRateLimits(db);
    const call = await callRoute(client, PATCH, { body }, headers);
    expect(call.violations).toEqual([]);
    return call;
  };

  beforeAll(async () => {
    tenant = await createTenant(db, 'settings', { name: 'PT Settings', timeZone: 'Asia/Jakarta', siteCount: 2 });
    admin = await addPerson(db, 'settings.admin', [{ org: tenant, adminRoles: ['tenant_admin'] }]);
    await addPerson(db, 'settings.admin2', [{ org: tenant, adminRoles: ['tenant_admin', 'storage_admin'] }]);
    await addPerson(db, 'settings.former', [{ org: tenant, adminRoles: ['tenant_admin'], status: 'disabled' }]);
    full = await createOnboardingApp(db);
    ta = await sessionIn(full, admin.id, tenant);
  });
  afterAll(async () => {
    await full?.close();
  });

  it('shows the permanent slug, the settings, the installation id, the tenancy mode and the active admin count', async () => {
    const installation = await inPlatform(db, (trx) => trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow());
    const row = await inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('updated_at').where('id', '=', tenant.id).executeTakeFirstOrThrow());
    const call = await callRoute<OrganizationSettings>(ta, GET, {});
    // The ETag of the organisation row, in the body and in the header (R-18, D.1 Concurrency).
    expect(call.headers.etag).toBe(`W/"${row.updated_at.getTime()}"`);
    expect(call.body).toEqual({
      slug: 'settings',
      name: 'PT Settings',
      timeZone: 'Asia/Jakarta',
      siteCount: 2,
      localLogin: 'allowed',
      installationId: installation.id,
      tenancyMode: full.get<MscdConfig>(MscdConfig).profile.tenancy.mode,
      activeAdminCount: 2,
      etag: `W/"${row.updated_at.getTime()}"`,
      offboardingEndsAt: null,
      deletionScheduledFor: null,
    });
  });

  it('changes the name, the time zone and the number of sites in one org.updated entry, with the canonical zone', async () => {
    const changed = await patch({ name: '  PT Settings Baru ', timeZone: 'america/new_york', siteCount: 3 });
    expect(changed.status, changed.text).toBe(204);
    expect(await settings()).toMatchObject({ slug: 'settings', name: 'PT Settings Baru', timeZone: 'America/New_York', siteCount: 3, localLogin: 'allowed' });
    expect(await tenantAudit(db, tenant, 'org.updated')).toEqual([
      {
        management_system_id: null,
        entity_id: tenant.id,
        before_data: { name: 'PT Settings', timeZone: 'Asia/Jakarta', siteCount: 2 },
        after_data: { name: 'PT Settings Baru', timeZone: 'America/New_York', siteCount: 3 },
      },
    ]);
    expect(await tenantAudit(db, tenant, 'org.settings_updated')).toEqual([]);
    // The organisation cache is refreshed after the commit: the next request reads the new name and site count.
    const me = await ta.get<{ org: { name: string } | null; tenants?: { id: string; name: string; sites: number }[] }>('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.org?.name).toBe('PT Settings Baru');

    // Only what changes is written; the same values write nothing.
    expect((await patch({ name: 'PT Settings Baru', timeZone: 'America/New_York', siteCount: 3 })).status).toBe(204);
    expect((await patch({ siteCount: 4 })).status).toBe(204);
    const entries = await tenantAudit(db, tenant, 'org.updated');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ before_data: { siteCount: 3 }, after_data: { siteCount: 4 } });
  });

  it('keeps org.settings_updated for the local sign-in policy', async () => {
    expect((await patch({ localLogin: 'admins_only' })).status).toBe(204);
    expect(await tenantAudit(db, tenant, 'org.settings_updated')).toEqual([
      expect.objectContaining({ before_data: { localLogin: 'allowed' }, after_data: { localLogin: 'admins_only' } }),
    ]);
    expect((await settings()).localLogin).toBe('admins_only');
    expect(await tenantAudit(db, tenant, 'org.updated')).toHaveLength(2);
    expect((await patch({ localLogin: 'allowed' })).status).toBe(204);
  });

  it('refuses an unknown time zone, the slug, an empty body and a negative site count with 400', async () => {
    const unknown = await patch({ timeZone: 'Mars/Olympus_Mons' });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('body.timeZone');
    for (const body of [{ slug: 'renamed' }, {}, { siteCount: -1 }, { name: '   ' }, { timeZone: '' }]) {
      const refused = await patch(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(await settings()).toMatchObject({ slug: 'settings', timeZone: 'America/New_York', siteCount: 4 });
    expect(await tenantAudit(db, tenant, 'org.updated')).toHaveLength(2);
  });

  it('answers 403 to a member without org.settings.manage', async () => {
    const member = await addPerson(db, 'settings.member', [{ org: tenant }]);
    const client = await sessionIn(full, member.id, tenant);
    expect((await client.get('/api/v1/admin/organization')).status).toBe(403);
    expect((await patch({ siteCount: 9 }, client)).status).toBe(403);
  });

  it('answers 412 to a stale If-Match before writing anything, and takes the current ETag (R-18)', async () => {
    const before = await settings();
    const entries = (await tenantAudit(db, tenant, 'org.updated')).length;
    const changed = await patch({ siteCount: 5 }, ta, { 'if-match': before.etag });
    expect(changed.status, changed.text).toBe(204);
    const after = await settings();
    expect(after).toMatchObject({ siteCount: 5 });
    expect(after.etag).not.toBe(before.etag);
    // A second admin with the form of before: refused, and nothing is written (the time zone stays).
    const stale = await patch({ timeZone: 'Asia/Tokyo', siteCount: 6 }, ta, { 'if-match': before.etag });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ status: 412 });
    expect(await settings()).toMatchObject({ timeZone: after.timeZone, siteCount: 5, etag: after.etag });
    expect(await tenantAudit(db, tenant, 'org.updated')).toHaveLength(entries + 1);
    // `*` and a list that names the current version pass; without If-Match the PATCH is not checked (D.1).
    expect((await patch({ siteCount: 6 }, ta, { 'if-match': `${before.etag}, ${after.etag}` })).status).toBe(204);
    expect((await patch({ siteCount: 5 }, ta, { 'if-match': '*' })).status).toBe(204);
    expect((await patch({ siteCount: 5 })).status).toBe(204);
  });

  it('locks the organisation row FOR NO KEY UPDATE: a grant that holds the audit chain lock and then references the organisation goes through', async () => {
    // An auditor access grant takes the tenant audit chain lock (an audit entry) and then inserts rows whose foreign
    // key names the organisation (the guest membership). The PATCH locks the organisation row and then writes its audit
    // entry. With FOR UPDATE on the row the two waited for each other (a deadlock); FOR NO KEY UPDATE lets the key
    // share lock of the foreign key check through.
    const guest = await addPerson(db, 'settings.guest', []);
    let chainHeld!: () => void;
    let insertNow!: () => void;
    const held = new Promise<void>((resolve) => (chainHeld = resolve));
    const go = new Promise<void>((resolve) => (insertNow = resolve));
    const grant = inScope(db.app, { orgId: tenant.id, schema: tenant.schemaName, userId: admin.id }, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenant.schemaName}.audit_trail`}, 42))`.execute(trx);
      chainHeld();
      await go;
      await sql`set local lock_timeout = '20s'`.execute(trx);
      await trx.insertInto('platform.org_membership').values({ organization_id: tenant.id, user_id: guest.id, admin_roles: [], status: 'invited', is_default: false }).execute();
    });
    await held;
    await resetRateLimits(db);
    const patching = callRoute(ta, PATCH, { body: { siteCount: 8 } });
    // Whatever happens below, the grant goes on (and ends within its lock timeout), so no transaction is left open.
    onTestFinished(() => insertNow());
    // The PATCH holds the organisation row and waits for the chain lock.
    const waitingForChain = async () =>
      (
        await sql<{ n: number }>`
          select count(*)::int as n from pg_locks
           where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`.execute(db.migrator)
      ).rows[0]!.n;
    await waitFor(async () => (await waitingForChain()) > 0, 20_000);
    // The row is held against another change, and open to a foreign key check.
    const rowLock = (mode: 'update' | 'key share') =>
      inPlatform(db, (trx) => sql`select id from platform.organization where id = ${tenant.id} for ${sql.raw(mode)} nowait`.execute(trx));
    await expectPgError(rowLock('update'), '55P03');
    await rowLock('key share');
    insertNow();
    await expect(grant).resolves.toBeUndefined();
    const done = await patching;
    expect(done.status, done.text).toBe(204);
    expect((await settings()).siteCount).toBe(8);
  });
});


describe('daily job ledger (Milestone 2 D.2, risk table I)', () => {
  const db = useTestDatabase('empty');
  let jobs: JobsApp;
  let full: FullApp;

  /** One tick at `at`; the runs it enqueued for `tenant`. */
  const tick = async (at: string, tenant: CreatedTenant) => {
    jobs.setNow(at);
    const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
    return result.enqueued.filter((e) => e.orgId === tenant.id);
  };
  const ledger = (tenant: CreatedTenant) =>
    inPlatform(db, (trx) =>
      trx
        .selectFrom('platform.daily_job_run')
        .select(['job', 'local_date', 'scheduled_for', 'enqueued_at'])
        .where('organization_id', '=', tenant.id)
        .orderBy('local_date')
        .orderBy('scheduled_for')
        .execute(),
    );
  const setZone = (tenant: CreatedTenant, zone: string) =>
    inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ time_zone: zone }).where('id', '=', tenant.id).execute());

  beforeAll(async () => {
    // Only the tick has a worker, so the jobs it enqueues stay waiting for inspection. The daily jobs with a handler
    // in this application are license.check (00:05), tasks.overdue (00:15) and audit-prep.generate (00:30). The test
    // profile fixes today (`demo.fixed_today`), which would replace every date; these tests run without it.
    jobs = await createJobsApp(db, { queues: ['scheduler.tick'], env: { MSCD__DEMO__FIXED_TODAY: 'null' } });
    full = await createOnboardingApp(db);
  });
  afterAll(async () => {
    await full?.close();
    await jobs?.close();
  });

  it('writes a ledger row per run and sends its job with the date in the payload; a second tick in the hour sends nothing', async () => {
    const tenant = await createTenant(db, 'ledger_hour', { timeZone: 'Asia/Jakarta' });
    // 17:05 UTC is 00:05 on 16 January 2030 in Jakarta.
    const first = await tick('2030-01-15T17:05:00Z', tenant);
    expect(first.map((e) => [e.name, e.localDate, e.singletonKey, e.startAfterSeconds, e.path])).toEqual([
      ['license.check', '2030-01-16', `lc:${tenant.id}:2030-01-16`, 0, 'due'],
      ['tasks.overdue', '2030-01-16', `to:${tenant.id}:2030-01-16`, 600, 'due'],
      ['audit-prep.generate', '2030-01-16', `ap:${tenant.id}:2030-01-16`, 1500, 'due'],
    ]);
    expect((await ledger(tenant)).map((r) => [r.job, r.local_date, r.scheduled_for.toISOString(), r.enqueued_at.toISOString()])).toEqual([
      ['license.check', '2030-01-16', '2030-01-15T17:05:00.000Z', '2030-01-15T17:05:00.000Z'],
      ['tasks.overdue', '2030-01-16', '2030-01-15T17:15:00.000Z', '2030-01-15T17:05:00.000Z'],
      ['audit-prep.generate', '2030-01-16', '2030-01-15T17:30:00.000Z', '2030-01-15T17:05:00.000Z'],
    ]);
    const queued = jobs.queue.waitingJobs().filter((j) => j.env.orgId === tenant.id);
    expect(queued.map((j) => [j.name, j.env.payload])).toEqual([
      ['license.check', { localDate: '2030-01-16' }],
      ['tasks.overdue', { localDate: '2030-01-16' }],
      ['audit-prep.generate', { localDate: '2030-01-16' }],
    ]);
    // A second tick in that hour (a duplicate or a retry), and one that comes 40 minutes late: nothing new.
    expect(await tick('2030-01-15T17:06:00Z', tenant)).toEqual([]);
    expect(await tick('2030-01-15T17:45:00Z', tenant)).toEqual([]);
    expect(await ledger(tenant)).toHaveLength(3);
    expect(jobs.queue.waitingJobs().filter((j) => j.env.orgId === tenant.id)).toHaveLength(3);
  });

  it('deletes the row of a run whose send pg-boss drops for a key `<prefix>:<org>:all`, and sends the run at a later tick', async () => {
    // The real queue: pg-boss reports a dropped send inside the tick's transaction. The tick plans the jobs below as
    // if their handlers ran in this application.
    await ensurePgBossSchema(db.urls.migrator);
    const boss = new PgBossJobQueue({ connectionString: db.urls.app, supervise: false, schedule: false });
    onTestFinished(() => boss.stop());
    const handled = ['license.check', 'readiness.recompute', 'drift.evaluate'];
    const registry = { discover: () => handled.map((name) => ({ metadata: { name } })) } as unknown as JobHandlerRegistry;
    const scheduler = new SchedulerTickJob(jobs.moduleRef.get(TenantScope), jobs.moduleRef.get(Clock), registry, boss);
    const tenant = await createTenant(db, 'ledger_drop', { timeZone: 'Asia/Jakarta' });
    const tickAt = async (at: string) => {
      jobs.setNow(at);
      const result = await scheduler.tick();
      const of = (runs: TickRun[]) => runs.filter((e) => e.orgId === tenant.id).map((e) => `${e.name}@${e.localDate}`);
      return { enqueued: of(result.enqueued), deferred: of(result.deferred), alreadyQueued: of(result.alreadyQueued) };
    };
    const queued = async (name: string) =>
      (
        await sql<{ id: string; local_date: string | null }>`
          select id, data->'payload'->>'localDate' as local_date from pgboss.job
           where name = ${name} and data->>'orgId' = ${tenant.id} and state in ('created', 'retry', 'active') order by created_on`.execute(db.migrator)
      ).rows;
    const finish = (id: string) => sql`delete from pgboss.job where id = ${id}`.execute(db.migrator);
    const days = async () => (await ledger(tenant)).map((r) => `${r.job}@${r.local_date}`).sort();
    // The ledger has a run of 1 April, so missed runs are caught up. A command queued a recompute of every system,
    // which holds the key `rr:<org>:all`.
    await inPlatform(db, (trx) =>
      trx.insertInto('platform.daily_job_run').values({ organization_id: tenant.id, job: 'license.check', local_date: '2030-04-01', scheduled_for: new Date('2030-03-31T17:05:00Z') }).execute(),
    );
    const command = await boss.send('readiness.recompute', { orgId: tenant.id, payload: {} }, { singletonKey: `rr:${tenant.id}:all`, startAfterSeconds: 60 });
    expect(command).not.toBeNull();

    // 03:05 on 4 April in Jakarta after an outage: 3 April is caught up. The queue drops readiness.recompute, so the
    // tick deletes its row.
    expect(await tickAt('2030-04-03T20:05:00Z')).toEqual({
      enqueued: ['license.check@2030-04-03', 'drift.evaluate@2030-04-03'],
      deferred: ['readiness.recompute@2030-04-03'],
      alreadyQueued: [],
    });
    expect(await days()).toEqual(['drift.evaluate@2030-04-03', 'license.check@2030-04-01', 'license.check@2030-04-03']);
    expect((await queued('drift.evaluate')).map((j) => j.local_date)).toEqual(['2030-04-03']);

    // A retried tick 20 seconds later sends nothing: license.check and drift.evaluate have runs that may still wait
    // or work, and the command's recompute still holds the key of readiness.recompute.
    expect(await tickAt('2030-04-03T20:05:20Z')).toEqual({ enqueued: [], deferred: ['readiness.recompute@2030-04-03'], alreadyQueued: [] });

    // The command's recompute is done. 35 minutes later readiness.recompute of 3 April follows, and license.check
    // of 4 April. drift.evaluate of 3 April still waits, so its run of 4 April is dropped and left to a later tick.
    await finish(command!);
    expect(await tickAt('2030-04-03T20:40:00Z')).toEqual({
      enqueued: ['license.check@2030-04-04', 'readiness.recompute@2030-04-03'],
      deferred: ['drift.evaluate@2030-04-04'],
      alreadyQueued: [],
    });
    expect((await queued('readiness.recompute')).map((j) => j.local_date)).toEqual(['2030-04-03']);

    // drift.evaluate of 3 April is done; the next tick sends its run of 4 April, once (readiness.recompute of 4 April
    // waits for 30 minutes after the run of 3 April).
    await finish((await queued('drift.evaluate'))[0]!.id);
    expect(await tickAt('2030-04-03T21:05:00Z')).toEqual({ enqueued: ['drift.evaluate@2030-04-04'], deferred: [], alreadyQueued: [] });
    expect((await queued('drift.evaluate')).map((j) => j.local_date)).toEqual(['2030-04-04']);
    expect((await days()).filter((d) => d.startsWith('drift.evaluate'))).toEqual(['drift.evaluate@2030-04-03', 'drift.evaluate@2030-04-04']);
  });

  it('catches up a date that a move east skips, once, and runs no date twice after a move west', async () => {
    const east = await createTenant(db, 'ledger_east', { timeZone: 'America/New_York' });
    const west = await createTenant(db, 'ledger_west', { timeZone: 'Asia/Tokyo' });
    /** The runs of one tick at `at` for both organisations, as `job@date`. */
    const both = async (at: string) => {
      jobs.setNow(at);
      const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
      const of = (tenant: CreatedTenant) => result.enqueued.filter((e) => e.orgId === tenant.id).map((e) => `${e.name}@${e.localDate}`);
      return { east: of(east), west: of(west) };
    };
    const daily = (date: string) => [`license.check@${date}`, `tasks.overdue@${date}`, `audit-prep.generate@${date}`];
    const hourly = (from: string, hours: number) => Array.from({ length: hours }, (_, i) => new Date(Date.parse(from) + i * 3_600_000).toISOString());
    // Tokyo runs 20 and 21 January (00:05 there is 15:05 UTC), New York runs 20 January (00:05 there is 05:05 UTC).
    expect((await both('2030-01-19T15:05:00Z')).west).toEqual(daily('2030-01-20'));
    expect((await both('2030-01-20T05:05:00Z')).east).toEqual(daily('2030-01-20'));
    expect((await both('2030-01-20T15:05:00Z')).west).toEqual(daily('2030-01-21'));
    // At 01:00 on 21 January in Tokyo the second organisation moves to New York (11:00 on 20 January there). The
    // rest of 20 January in New York runs nothing again.
    await setZone(west, 'America/New_York');
    for (const at of hourly('2030-01-20T17:05:00Z', 12)) expect(await both(at), at).toEqual({ east: [], west: [] });
    // At 23:30 on 20 January in New York the first organisation moves to Tokyo (13:30 on 21 January there): the next
    // tick runs the jobs of 21 January at once. For the second organisation 21 January starts and is in the ledger.
    await setZone(east, 'Asia/Tokyo');
    const caught = await both('2030-01-21T05:05:00Z');
    expect(caught).toEqual({ east: daily('2030-01-21'), west: [] });
    jobs.setNow('2030-01-21T05:05:00Z');
    const paths = (await jobs.moduleRef.get(SchedulerTickJob).tick()).enqueued.filter((e) => e.orgId === east.id);
    expect(paths).toEqual([]);
    // The rest of 21 January in New York runs nothing; 00:05 on 22 January in Tokyo runs that date for the first.
    for (const at of hourly('2030-01-21T06:05:00Z', 23)) {
      expect(await both(at), at).toEqual({ east: at === '2030-01-21T15:05:00.000Z' ? daily('2030-01-22') : [], west: [] });
    }
    // 00:05 on 22 January in New York runs that date for the second organisation, once.
    expect(await both('2030-01-22T05:05:00Z')).toEqual({ east: [], west: daily('2030-01-22') });
    expect(await both('2030-01-22T05:35:00Z')).toEqual({ east: [], west: [] });
    const rows = await ledger(east);
    expect(rows.filter((r) => r.local_date === '2030-01-21').every((r) => r.scheduled_for < new Date('2030-01-21T05:05:00Z'))).toBe(true);
  });

  it('keeps a delayed job on the date of its run when a PATCH moves the zone across the date line before it starts', async () => {
    const tenant = await createTenant(db, 'ledger_patch', { timeZone: 'Pacific/Kiritimati' });
    const admin = await addPerson(db, 'ledger.admin', [{ org: tenant, adminRoles: ['tenant_admin'] }]);
    const client = await sessionIn(full, admin.id, tenant);
    // 10:05 UTC is 00:05 on 16 January in Kiritimati (UTC+14): tasks.overdue waits for 00:15.
    const runs = await tick('2030-01-15T10:05:00Z', tenant);
    expect(runs.find((e) => e.name === 'tasks.overdue')).toMatchObject({ localDate: '2030-01-16', startAfterSeconds: 600 });
    // The Tenant Admin moves the organisation to Pago Pago (UTC-11), where it is still 14 January.
    await resetRateLimits(db);
    const moved = await callRoute(client, PATCH, { body: { timeZone: 'Pacific/Pago_Pago' } });
    expect(moved.status, moved.text).toBe(204);
    // The worker's cache sees the new zone (its 60 second lifetime has passed).
    jobs.moduleRef.get(TenantResolver).invalidate(tenant.id);
    jobs.setNow('2030-01-15T10:15:00Z');
    const clock = jobs.moduleRef.get(Clock);
    expect(await clock.today(tenant.id)).toBe('2030-01-14');
    // The job starts and works on 16 January, the date of its run and its ledger row.
    const job = jobs.queue.waitingJobs('tasks.overdue').find((j) => j.env.orgId === tenant.id)!;
    expect(job.env.payload).toEqual({ localDate: '2030-01-16' });
    const runDate = vi.spyOn(clock, 'runDate');
    try {
      await jobs.moduleRef.get(TasksOverdueJob).handle(job as never);
      expect(runDate).toHaveBeenCalledWith(tenant.id, '2030-01-16');
      expect(await runDate.mock.results[0]!.value).toBe('2030-01-16');
    } finally {
      runDate.mockRestore();
    }
    expect((await ledger(tenant)).filter((r) => r.job === 'tasks.overdue').map((r) => r.local_date)).toEqual(['2030-01-16']);
    // Pago Pago reaches 15 and 16 January later: 15 January runs as usual, 16 January finds its rows.
    expect((await tick('2030-01-15T11:05:00Z', tenant)).map((e) => `${e.name}@${e.localDate}`)).toEqual([
      'license.check@2030-01-15',
      'tasks.overdue@2030-01-15',
      'audit-prep.generate@2030-01-15',
    ]);
    expect(await tick('2030-01-16T11:05:00Z', tenant)).toEqual([]);
  });

  it('runs a job without a date in its payload (a manual run) on today in the organisation', async () => {
    const tenant = await createTenant(db, 'ledger_manual', { timeZone: 'Asia/Jakarta' });
    jobs.setNow('2030-02-01T03:00:00Z');
    const clock = jobs.moduleRef.get(Clock);
    const runDate = vi.spyOn(clock, 'runDate');
    try {
      await jobs.moduleRef.get(TasksOverdueJob).handle({ id: 'manual', name: 'tasks.overdue', env: { orgId: tenant.id, payload: {} }, attempt: 1 });
      expect(await runDate.mock.results[0]!.value).toBe('2030-02-01');
      await expect(clock.runDate(tenant.id, '2030-13-01')).rejects.toThrow(/YYYY-MM-DD/);
    } finally {
      runDate.mockRestore();
    }
  });

  it('lets an organisation read its own ledger rows and only the platform scope write them (F.10)', async () => {
    const a = await createTenant(db, 'ledger_rls_a');
    const b = await createTenant(db, 'ledger_rls_b');
    const row = (tenant: CreatedTenant) => ({ organization_id: tenant.id, job: 'license.check', local_date: '2030-04-01', scheduled_for: new Date('2030-03-31T17:05:00Z') });
    await inScope(db.app, { platformScope: true }, (trx) => trx.insertInto('platform.daily_job_run').values([row(a), row(b)]).execute());
    const seen = await inScope(db.app, { orgId: a.id }, (trx) => trx.selectFrom('platform.daily_job_run').select('organization_id').distinct().execute());
    expect(seen.map((r) => r.organization_id)).toEqual([a.id]);
    await expectPgError(
      rolledBack(db.app, { orgId: a.id }, (trx) => trx.insertInto('platform.daily_job_run').values({ ...row(a), local_date: '2030-04-02' }).execute()),
      '42501',
    );
    expect(Number((await inScope(db.app, { orgId: a.id }, (trx) => trx.deleteFrom('platform.daily_job_run').executeTakeFirst())).numDeletedRows)).toBe(0);
    await expectPgError(
      rolledBack(db.app, { platformScope: true }, (trx) => sql`update platform.daily_job_run set local_date = '2030-04-03'`.execute(trx)),
      '42501',
      /permission denied/,
    );
  });

  it('deletes ledger rows more than 14 days old', async () => {
    const tenant = await createTenant(db, 'ledger_old', { timeZone: 'Asia/Jakarta' });
    await inPlatform(db, (trx) =>
      trx
        .insertInto('platform.daily_job_run')
        .values([
          { organization_id: tenant.id, job: 'license.check', local_date: '2030-02-15', scheduled_for: new Date('2030-02-14T17:05:00Z') },
          { organization_id: tenant.id, job: 'license.check', local_date: '2030-02-16', scheduled_for: new Date('2030-02-15T17:05:00Z') },
        ])
        .execute(),
    );
    jobs.setNow('2030-03-02T06:05:00Z');
    const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
    expect(result.ledgerRowsDeleted).toBeGreaterThanOrEqual(1);
    // The tick also ran the organisation's missed runs of 1 March (the ledger has an earlier date).
    expect((await ledger(tenant)).map((r) => r.local_date).filter((d) => d < '2030-03-01')).toEqual(['2030-02-16']);
  });
});
