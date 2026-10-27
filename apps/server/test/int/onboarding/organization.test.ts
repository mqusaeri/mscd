// Organisation settings (Milestone 2 D.1, D.2): `GET /admin/organization` and `PATCH /admin/organization` with the
// name, the IANA time zone and the number of sites (one `org.updated` entry with before and after; the local sign-in
// policy keeps `org.settings_updated`), and the daily jobs after a time zone change (risk table I): each local date
// is planned once, so a zone further west does not run a date twice and a zone further east does not skip one.
import { API_ROUTES, type OrganizationSettings } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobHandlerRegistry } from '../../../src/common/jobs/job-handler';
import { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { SchedulerTickJob, planDailyJobs, type TimeZoneChange } from '../../../src/modules/jobs/scheduler-tick.job';
import { DAILY_JOBS, dueDailyJobs, localTimeOf, type DailyJob } from '../../../src/modules/jobs/schedules';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { createJobsApp, type JobsApp } from '../jobs/helpers';
import { addPerson, createOnboardingApp, inPlatform, inTenant, resetRateLimits, sessionIn, tenantAudit, type Client, type Person } from './helpers';

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
  const patch = async (body: unknown, client: Client = ta) => {
    await resetRateLimits(db);
    const call = await callRoute(client, PATCH, { body });
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
    expect(await settings()).toEqual({
      slug: 'settings',
      name: 'PT Settings',
      timeZone: 'Asia/Jakarta',
      siteCount: 2,
      localLogin: 'allowed',
      installationId: installation.id,
      tenancyMode: full.get<MscdConfig>(MscdConfig).profile.tenancy.mode,
      activeAdminCount: 2,
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
});

describe('daily jobs after a time zone change (Milestone 2 D.2, risk table I)', () => {
  const db = useTestDatabase('empty');
  const ORG = '00000000-0000-4000-8000-0000000000aa';
  // Three jobs: early, morning, and one with the per-organisation key `<prefix>:<org>:all`.
  const JOBS: DailyJob[] = [
    { name: 'license.check', at: '00:05', prefix: 'lc', retryLimit: 3 },
    { name: 'cycle.derive', at: '03:15', prefix: 'cd', allSystems: true, retryLimit: 3 },
    { name: 'notifications.digest', at: '07:00', prefix: 'ndg', retryLimit: 3 },
  ];
  const plan = (now: string, zone: string, changes: TimeZoneChange[]) =>
    planDailyJobs(ORG, new Date(now), zone, changes, JOBS).map((d) => [d.singletonKey, d.startAfterSeconds]);
  const keys = (now: string, zone: string, changes: TimeZoneChange[]) => plan(now, zone, changes).map(([key]) => key);

  it('does not run a local date twice after a move west (Asia/Jakarta to America/New_York)', () => {
    const west: TimeZoneChange[] = [{ at: new Date('2030-01-15T18:00:00Z'), from: 'Asia/Jakarta', to: 'America/New_York' }];
    // Jakarta ran 16 January at 2030-01-15 17:05 UTC (00:05 local), before the change. At 00:05 on 16 January in New
    // York the same date would run again; without the change it is due.
    expect(dueDailyJobs(ORG, new Date('2030-01-16T05:05:00Z'), 'America/New_York', JOBS).map((d) => d.singletonKey)).toEqual([`lc:${ORG}:2030-01-16`]);
    expect(keys('2030-01-16T05:05:00Z', 'America/New_York', west)).toEqual([]);
    // The digest of 16 January never ran in Jakarta (its 07:00 came after the change): New York runs it.
    expect(keys('2030-01-16T12:05:00Z', 'America/New_York', west)).toEqual([`ndg:${ORG}:2030-01-16`]);
    // The next date runs as usual.
    expect(keys('2030-01-17T05:05:00Z', 'America/New_York', west)).toEqual([`lc:${ORG}:2030-01-17`]);
    // First tick after the change (13:05 on 15 January in New York): every job of 15 January already ran in Jakarta.
    expect(keys('2030-01-15T18:05:00Z', 'America/New_York', west)).toEqual([]);
  });

  it('catches up a local date that would be skipped after a move east (America/New_York to Asia/Tokyo)', () => {
    const east: TimeZoneChange[] = [{ at: new Date('2030-01-15T03:30:00Z'), from: 'America/New_York', to: 'Asia/Tokyo' }];
    // At the change it is 22:30 on 14 January in New York and 12:30 on 15 January in Tokyo: the jobs of 15 January
    // ran in neither zone. The first tick after the change enqueues those whose hour has passed, at once.
    expect(dueDailyJobs(ORG, new Date('2030-01-15T04:05:00Z'), 'Asia/Tokyo', JOBS)).toEqual([]);
    expect(plan('2030-01-15T04:05:00Z', 'Asia/Tokyo', east)).toEqual([
      [`lc:${ORG}:2030-01-15`, 0],
      [`cd:${ORG}:all`, 0],
      [`ndg:${ORG}:2030-01-15`, 0],
    ]);
    // Later ticks of the day add nothing; the next date runs at its hour.
    expect(keys('2030-01-15T05:05:00Z', 'Asia/Tokyo', east)).toEqual([]);
    expect(keys('2030-01-15T15:05:00Z', 'Asia/Tokyo', east)).toEqual([`lc:${ORG}:2030-01-16`]);
  });

  it('catches up only what the earlier zone did not run (Asia/Jakarta to Asia/Tokyo, two hours east)', () => {
    // At 2030-01-15 16:30 UTC it is 23:30 on 15 January in Jakarta and 01:30 on 16 January in Tokyo: 16 January
    // started in Tokyo without its 00:05 job, which Jakarta would only have run at 17:05 UTC.
    const east: TimeZoneChange[] = [{ at: new Date('2030-01-15T16:30:00Z'), from: 'Asia/Jakarta', to: 'Asia/Tokyo' }];
    expect(plan('2030-01-15T17:05:00Z', 'Asia/Tokyo', east)).toEqual([[`lc:${ORG}:2030-01-16`, 0]]);
    // Changing back the next day (Tokyo to Jakarta, west): 17 January is not run twice.
    const back: TimeZoneChange[] = [...east, { at: new Date('2030-01-16T15:30:00Z'), from: 'Asia/Tokyo', to: 'Asia/Jakarta' }];
    expect(keys('2030-01-16T17:05:00Z', 'Asia/Jakarta', back)).toEqual([]);
    expect(keys('2030-01-17T17:05:00Z', 'Asia/Jakarta', back)).toEqual([`lc:${ORG}:2030-01-18`]);
    // The first tick after the change back (23:05 on 16 January in Jakarta) catches up nothing: every job of 16 January
    // ran in Tokyo, the first one in the catch-up of 17:05 UTC on 15 January.
    expect(keys('2030-01-16T16:05:00Z', 'Asia/Jakarta', back)).toEqual([]);
  });

  it('catches up at the first tick after the change, whether that tick starts on time, late or early', () => {
    // Asia/Jakarta (UTC+7) to Asia/Jayapura (UTC+9) at 22:05:20 UTC, after the tick of 05:05 in Jakarta. Jakarta never
    // reached 07:00 on 27 October, so the next tick, at 08:05 in Jayapura, runs the digest of that date at once.
    const east: TimeZoneChange[] = [{ at: new Date('2026-10-26T22:05:20Z'), from: 'Asia/Jakarta', to: 'Asia/Jayapura' }];
    const digest = [[`ndg:${ORG}:2026-10-27`, 0]];
    for (const now of ['2026-10-26T23:05:00Z', '2026-10-26T23:05:40Z', '2026-10-26T23:04:58Z', '2026-10-26T23:40:00Z']) {
      expect(plan(now, 'Asia/Jayapura', east), now).toEqual(digest);
      // The same with the instant of the tick before, as the clock high-water mark gives it.
      const withPrevious = planDailyJobs(ORG, new Date(now), 'Asia/Jayapura', east, JOBS, new Date('2026-10-26T22:05:05Z'));
      expect(withPrevious.map((d) => [d.singletonKey, d.startAfterSeconds]), now).toEqual(digest);
    }
    expect(keys('2026-10-27T00:05:00Z', 'Asia/Jayapura', east)).toEqual([]);
  });

  it('plans the slot of a tick that starts just after a change with the old zone, and catches up once at the next slot', () => {
    // The change comes at 22:05:02 UTC and the tick of 22:05 starts at 22:05:10: it plans 05:05 in Jakarta, the hour
    // it is scheduled for. The next tick catches up the digest of 27 October once, with or without the previous tick.
    const east: TimeZoneChange[] = [{ at: new Date('2026-10-26T22:05:02Z'), from: 'Asia/Jakarta', to: 'Asia/Jayapura' }];
    const ticks = ['2026-10-26T22:05:10Z', '2026-10-26T23:05:00Z', '2026-10-27T00:05:00Z', '2026-10-27T15:05:00Z'];
    for (const withPrevious of [false, true]) {
      const planned = ticks.map((now, i) =>
        planDailyJobs(ORG, new Date(now), 'Asia/Jayapura', east, JOBS, withPrevious && i > 0 ? new Date(ticks[i - 1]!) : undefined).map((d) => d.singletonKey),
      );
      expect(planned, `with the previous tick: ${withPrevious}`).toEqual([[], [`ndg:${ORG}:2026-10-27`], [], [`lc:${ORG}:2026-10-28`]]);
    }
    // A change just after 00:05 in Jakarta: the late tick still runs the date's first job in Jakarta, and the next tick,
    // at 03:05 in Jayapura, does not run it again.
    const midnight: TimeZoneChange[] = [{ at: new Date('2026-10-26T17:05:02Z'), from: 'Asia/Jakarta', to: 'Asia/Jayapura' }];
    expect(plan('2026-10-26T17:05:10Z', 'Asia/Jayapura', midnight)).toEqual([[`lc:${ORG}:2026-10-27`, 0]]);
    expect(plan('2026-10-26T18:05:00Z', 'Asia/Jayapura', midnight)).toEqual([[`cd:${ORG}:all`, 600]]);
  });

  it('plans nothing at a second tick of a slot, and catches up at the first tick after a slot without one', () => {
    const east: TimeZoneChange[] = [{ at: new Date('2026-10-26T22:30:00Z'), from: 'Asia/Jakarta', to: 'Asia/Jayapura' }];
    const at = (now: string, previousTick: string) =>
      planDailyJobs(ORG, new Date(now), 'Asia/Jayapura', east, JOBS, new Date(previousTick)).map((d) => [d.singletonKey, d.startAfterSeconds]);
    expect(at('2026-10-26T23:05:00Z', '2026-10-26T22:05:00Z')).toEqual([[`ndg:${ORG}:2026-10-27`, 0]]);
    // A second tick in the slot of 23:05 UTC.
    expect(at('2026-10-26T23:20:00Z', '2026-10-26T23:05:00Z')).toEqual([]);
    // No tick in the slot of 23:05 UTC: the tick of 00:05 (09:05 in Jayapura) catches up the date.
    expect(at('2026-10-27T00:05:00Z', '2026-10-26T22:05:00Z')).toEqual([[`ndg:${ORG}:2026-10-27`, 0]]);
    // A clock set back hides the previous tick: the tick of the previous slot counts as the one before.
    expect(at('2026-10-26T23:05:00Z', '2026-11-30T00:05:00Z')).toEqual([[`ndg:${ORG}:2026-10-27`, 0]]);
    expect(at('2026-10-27T00:05:00Z', '2026-11-30T00:05:00Z')).toEqual([]);
  });

  it('enqueues each job once per local date when ticks start early, on time or late around a change', () => {
    const HOUR = 3_600_000;
    const dated: DailyJob[] = [
      { name: 'license.check', at: '00:05', prefix: 'lc', retryLimit: 3 },
      { name: 'freshness.sweep', at: '01:00', prefix: 'fs', retryLimit: 3 },
      { name: 'certificate.expiry', at: '06:00', prefix: 'ce', retryLimit: 3 },
      { name: 'notifications.digest', at: '07:00', prefix: 'ndg', retryLimit: 3 },
      { name: 'documents.review-alerts', at: '13:30', prefix: 'dra', retryLimit: 3 },
      { name: 'tasks.overdue', at: '23:00', prefix: 'to', retryLimit: 3 },
    ];
    const moves: [string, string][] = [
      ['Asia/Jakarta', 'Asia/Jayapura'],
      ['Asia/Jayapura', 'Asia/Jakarta'],
      ['Asia/Jakarta', 'America/New_York'],
      ['America/New_York', 'Asia/Tokyo'],
      ['Asia/Kolkata', 'Asia/Kathmandu'],
      ['Pacific/Kiritimati', 'Pacific/Pago_Pago'],
      ['Pacific/Pago_Pago', 'Pacific/Kiritimati'],
    ];
    // The change, in seconds after minute 5 of its UTC hour: just after the tick, a little later, mid-hour, and just
    // before the next tick.
    const offsets = [2, 20, 1800, 3598];
    // The start of each tick against minute 5, in seconds, in turn: on time, or late, early, on time and very late.
    const starts = [[0], [10, 40, -2, 0, 1500]];
    const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const base = Date.parse('2030-01-14T00:05:00Z');
    for (const [from, to] of moves) {
      for (const offset of offsets) {
        for (const start of starts) {
          for (const withPrevious of [false, true]) {
            const label = `${from} to ${to}, change ${offset} s after minute 5, starts ${start.join(' ')}, previous tick ${withPrevious}`;
            const change: TimeZoneChange = { at: new Date(base + 54 * HOUR + offset * 1000), from, to };
            const seen: string[] = [];
            let previous: Date | undefined;
            for (let i = 0; i < 140; i++) {
              const now = new Date(base + i * HOUR + start[i % start.length]! * 1000);
              const visible = change.at.getTime() <= now.getTime() ? [change] : [];
              const zone = visible.length > 0 ? to : from;
              for (const due of planDailyJobs(ORG, now, zone, visible, dated, withPrevious ? previous : undefined)) seen.push(due.singletonKey);
              previous = now;
            }
            expect(seen.filter((key, i) => seen.indexOf(key) !== i), label).toEqual([]);
            // Complete local dates: the day before the change in the old zone, and the first two days of the new zone
            // from its first tick after the change.
            const firstSlot = Math.ceil((change.at.getTime() - 5 * 60_000) / HOUR) * HOUR + 5 * 60_000;
            const newDate = localTimeOf(new Date(firstSlot), to).date;
            const dates = [addDays(localTimeOf(change.at, from).date, -1), newDate, addDays(newDate, 1)];
            const missing = dates.flatMap((date) => dated.map((job) => `${job.prefix}:${ORG}:${date}`)).filter((key) => !seen.includes(key));
            expect(missing, label).toEqual([]);
          }
        }
      }
    }
  });

  it('ignores changes older than the history window and plans as before without changes', () => {
    const old: TimeZoneChange[] = [{ at: new Date('2030-01-10T00:00:00Z'), from: 'Asia/Jakarta', to: 'America/New_York' }];
    expect(keys('2030-01-16T05:05:00Z', 'America/New_York', old)).toEqual([`lc:${ORG}:2030-01-16`]);
    expect(keys('2030-01-16T05:05:00Z', 'America/New_York', [])).toEqual([`lc:${ORG}:2030-01-16`]);
  });

  describe('scheduler.tick', () => {
    let jobs: JobsApp;
    let moved: CreatedTenant;
    let still: CreatedTenant;
    let late: CreatedTenant;

    /** Records a time zone change as `PATCH /admin/organization` does: the organisation row and its org.updated entry. */
    const changeZone = async (tenant: CreatedTenant, at: string, from: string, to: string) => {
      await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ time_zone: to }).where('id', '=', tenant.id).execute());
      await inTenant(db, tenant, (trx) =>
        trx
          .insertInto('audit_trail')
          .values({
            occurred_at: new Date(at),
            actor_kind: 'user',
            action: 'org.updated',
            entity_type: 'organization',
            entity_id: tenant.id,
            entity_code: tenant.slug,
            before_data: JSON.stringify({ timeZone: from }),
            after_data: JSON.stringify({ timeZone: to }),
            prev_hash: Buffer.alloc(0),
            row_hash: Buffer.alloc(0),
          } as never)
          .execute(),
      );
    };
    const enqueued = async (at: string, tenant: CreatedTenant) => {
      jobs.setNow(at);
      const result = await jobs.moduleRef.get(SchedulerTickJob).tick();
      return result.enqueued.filter((e) => e.orgId === tenant.id).map((e) => e.singletonKey);
    };

    beforeAll(async () => {
      moved = await createTenant(db, 'tz_moved', { timeZone: 'America/New_York' });
      still = await createTenant(db, 'tz_still', { timeZone: 'America/New_York' });
      late = await createTenant(db, 'tz_late', { timeZone: 'Asia/Jakarta' });
      jobs = await createJobsApp(db, { queues: ['scheduler.tick'] });
    });
    afterAll(async () => {
      await jobs?.close();
    });

    it('reads the change from the audit trail and enqueues the skipped date once', async () => {
      await changeZone(moved, '2030-01-15T03:30:00Z', 'America/New_York', 'Asia/Tokyo');
      // 13:05 on Tuesday 15 January in Tokyo: every daily job of this build whose hour has passed, keyed with the date.
      const handled = new Set(jobs.moduleRef.get(JobHandlerRegistry).discover().map((h) => h.metadata.name));
      const expected = DAILY_JOBS.filter((d) => handled.has(d.name) && Number(d.at.slice(0, 2)) < 13 && d.weekday === undefined).map(
        (d) => (d.allSystems ? `${d.prefix}:${moved.id}:all` : `${d.prefix}:${moved.id}:2030-01-15`),
      );
      const first = await enqueued('2030-01-15T04:05:00Z', moved);
      expect(first).toContain(`lc:${moved.id}:2030-01-15`);
      expect(first.sort()).toEqual(expected.sort());
      // The organisation that did not move gets nothing at 23:05 in New York.
      expect(await enqueued('2030-01-15T04:05:00Z', still)).toEqual([]);
      // The next hour adds nothing; 00:05 on 16 January in Tokyo runs the next date.
      expect(await enqueued('2030-01-15T05:05:00Z', moved)).toEqual([]);
      expect(await enqueued('2030-01-15T15:05:00Z', moved)).toContain(`lc:${moved.id}:2030-01-16`);
    });

    it('decides the catch-up against the previous tick, read from the clock high-water mark', async () => {
      // 04:05 on 21 January in Jakarta: nothing is due at that hour.
      expect(await enqueued('2030-01-20T21:05:00Z', late)).toEqual([]);
      // The change comes 2 seconds after minute 5 and that hour's tick starts 8 seconds late: it plans 05:05 in
      // Jakarta, the hour it is scheduled for, without a catch-up.
      await changeZone(late, '2030-01-20T22:05:02Z', 'Asia/Jakarta', 'Asia/Jayapura');
      expect(await enqueued('2030-01-20T22:05:10Z', late)).toEqual([]);
      // The next tick (08:05 in Jayapura) runs at once the jobs of 21 January from 06:00 to 07:59, which Jakarta never
      // reached; a second tick in that hour and the tick after add nothing.
      const handled = new Set(jobs.moduleRef.get(JobHandlerRegistry).discover().map((h) => h.metadata.name));
      const expected = DAILY_JOBS.filter((d) => handled.has(d.name) && d.at >= '06:00' && d.at < '08:00' && d.weekday === undefined).map(
        (d) => (d.allSystems ? `${d.prefix}:${late.id}:all` : `${d.prefix}:${late.id}:2030-01-21`),
      );
      expect(expected).toContain(`ndg:${late.id}:2030-01-21`);
      expect((await enqueued('2030-01-20T23:05:00Z', late)).sort()).toEqual(expected.sort());
      expect(await enqueued('2030-01-20T23:05:30Z', late)).toEqual([]);
      expect(await enqueued('2030-01-21T00:05:00Z', late)).toEqual([]);
    });
  });
});
