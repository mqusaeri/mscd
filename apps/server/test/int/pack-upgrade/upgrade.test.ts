// The upgrade path of an installed edition (Milestone 2 E.1, E.3; M2-03). The six development packs are installed
// into an organisation with systems, whose D2-09 entries are seeded; then a fixture version built from them marks
// 10.3 retired, retitles 10.1, adds the leaf row 9.2.1 under 9.2 and a cycle requirement. Checked: no row is deleted,
// 10.3 is retired and leaves the target list (what `applicability.targets` and the seeder read), the new row gets an
// entry and the open cycle the new item, `pack_content_updated` is sent once, a second run adds nothing, a version that
// drops a code instead of retiring it is refused (422 business-rule, rule PACK-ROW-REMOVED), a version that drops an
// activity template is accepted, an installation made outside the worker is picked up by `queuePending`, and a demo
// organisation (`demo_deploy_label` set) gets no entry and no notification.
import { parse } from 'csv-parse/sync';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { seedApplicability, seedTargets } from '../../../src/modules/implementation/applicability-seed';
import { ApplicabilitySyncService } from '../../../src/modules/packs/applicability-sync.service';
import { PackRejectedError } from '../../../src/modules/packs/pack-verification';
import { TenantScope, systemContextOf } from '../../../src/modules/tenancy/tenant-scope';
import { FAKE_PRINCIPAL_HEADER } from '../../setup/auth-fakes';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  addMember,
  changedPack,
  createPackApp,
  devLicence,
  grantRole,
  importForm,
  installDevPacks,
  orgIdentities,
  testInstaller,
  type MutableSource,
  type PackApp,
} from '../packs/fixtures';

const as = (who: string) => ({ [FAKE_PRINCIPAL_HEADER]: who });
const OPERATOR = { userId: null, kind: 'operator' as const };

type Row = Record<string, string>;

function field(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Rewrites one CSV dataset of a mutable source through `edit` on its rows. */
function editCsv(source: MutableSource, file: string, edit: (rows: Row[]) => Row[]): void {
  const text = source.datasets.get(file)!.toString('utf8');
  const [header, ...records] = parse(text, { relax_column_count: false }) as string[][];
  const rows = edit(records.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? '']))));
  const lines = [header!.join(','), ...rows.map((r) => header!.map((h) => field(r[h] ?? '')).join(','))];
  source.datasets.set(file, Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/** Clause codes in clause order (`9.2` before `9.2.1` before `9.3`). */
function byCode(a: Row, b: Row): number {
  const sa = a.requirement_code!.split('.').map(Number);
  const sb = b.requirement_code!.split('.').map(Number);
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
  }
  return 0;
}

/** The changes of the fixture version 1.2.2: 10.3 retired, 10.1 retitled, 9.2.1 added under 9.2, a cycle requirement. */
function fixtureChanges(s: MutableSource): void {
  editCsv(s, 'requirements.csv', (rows) => {
    const changed = rows.map((r) =>
      r.requirement_code === '10.3' ? { ...r, retired: 'true' } : r.requirement_code === '10.1' ? { ...r, title_short: 'Continual improvement' } : r,
    );
    changed.push({ ...rows.find((r) => r.requirement_code === '9.2')!, requirement_code: '9.2.1', parent_code: '9.2', title_short: 'Internal audit programme', is_hs_common: 'false' });
    return changed.sort(byCode).map((r, i) => ({ ...r, sort_order: String(i + 1) }));
  });
  editCsv(s, 'cycle_requirements.csv', (rows) => [
    ...rows,
    { code: 'FIXTURE_ITEM', requirement_code: '9.2', title: 'Audit programme confirmed for the cycle', derivation: '', sort_order: String(rows.length + 1) },
  ]);
}

function version(v: string, ...changes: ((s: MutableSource) => void)[]) {
  return changedPack('ISO27001-2022', (s) => {
    s.manifest.pack_version = v;
    for (const change of changes) change(s);
  });
}

function postImport(app: PackApp, who: string, bundle: Buffer) {
  const form = importForm(bundle);
  return app.app.inject({ method: 'POST', url: '/api/v1/admin/packs/import', headers: { ...as(who), 'content-type': form.contentType }, payload: form.payload });
}

async function refRowCounts(db: TestDatabase): Promise<Record<string, number>> {
  const { rows } = await sql<Record<string, string>>`
    select (select count(*) from ref.requirement) as requirements, (select count(*) from ref.catalogue_item) as catalogue,
           (select count(*) from ref.activity_template) as activities, (select count(*) from ref.cycle_requirement_def) as cycle_requirements,
           (select count(*) from ref.prep_task_template) as prep_tasks`.execute(db.migrator);
  return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]));
}

describe('pack upgrade path (Milestone 2 E.1, E.3)', () => {
  const db = useTestDatabase('empty');
  let org: CreatedTenant;
  let demo: CreatedTenant;
  let app: PackApp;
  let mm: string;
  let demoMm: string;
  const systems: Record<string, string> = {};
  let isoVersionId: string;

  const tenantRows = <T>(tenant: CreatedTenant, fn: (trx: Parameters<Parameters<typeof inScope>[2]>[0]) => Promise<T>) =>
    inScope(db.migrator, { orgId: tenant.id, schema: tenant.schemaName }, fn);
  const entryCodes = (tenant: CreatedTenant, msId: string) =>
    tenantRows(tenant, async (trx) => {
      const { rows } = await sql<{ code: string }>`
        select coalesce(c.item_code, r.requirement_code) as code from applicability_entry e
          left join ref.catalogue_item c on c.id = e.catalogue_item_id left join ref.requirement r on r.id = e.requirement_id
         where e.management_system_id = ${msId} and e.deleted_at is null order by e.position`.execute(trx);
      return rows.map((r) => r.code);
    });
  const notices = (tenant: CreatedTenant, userId: string) =>
    tenantRows(tenant, async (trx) =>
      trx.selectFrom('notification').select(['kind', 'title_en', 'body_en', 'body_id', 'management_system_id']).where('recipient_user_id', '=', userId).where('kind', '=', 'pack_content_updated').execute(),
    );
  const synced = () =>
    inScope(db.migrator, { platformScope: true }, async (trx) => {
      const { rows } = await sql<{ organization_id: string; management_system_id: string; after_data: Record<string, unknown>; edition: string | null }>`
        select organization_id, management_system_id, after_data, edition from platform.audit_log where action = 'pack.content_synced' order by seq`.execute(trx);
      return rows;
    });
  const sync = () => app.moduleRef.get(ApplicabilitySyncService);

  beforeAll(async () => {
    await installDevPacks(db);
    org = await createTenant(db, 'upg');
    demo = await createTenant(db, 'dmo', { demoDeployLabel: 'onprem' });
    const ta = await addMember(db, 'ta.upg', org.id, ['tenant_admin']);
    mm = await addMember(db, 'mm.upg', org.id);
    const demoTa = await addMember(db, 'ta.dmo', demo.id, ['tenant_admin']);
    demoMm = await addMember(db, 'mm.dmo', demo.id);
    app = await createPackApp(db, {
      identities: { ...orgIdentities(org, { ta, mm }, ['isms', 'qms']), ...orgIdentities(demo, { ta: demoTa, mm: demoMm }, ['isms']) },
    });
    for (const [tenant, who, list] of [[org, 'ta@upg', ['isms', 'qms']], [demo, 'ta@dmo', ['isms']]] as const) {
      expect((await app.app.inject({ method: 'PUT', url: '/api/v1/admin/license', headers: as(who), payload: devLicence(tenant.id) })).statusCode).toBe(200);
      for (const slug of list) {
        const body = slug === 'isms'
          ? { slug, code: 'ISMS', name: 'Information security', packId: 'ISO27001-2022', edition: '2022' }
          : { slug, code: 'QMS', name: 'Quality', packId: 'ISO9001-2015', edition: '2015' };
        const created = await app.app.inject({
          method: 'POST',
          url: '/api/v1/admin/management-systems',
          headers: as(who),
          payload: { ...body, scopeStatement: 'Whole organisation', defaultRepository: 'vault', color: '#e8731a' },
        });
        expect(created.statusCode, created.body).toBe(201);
        systems[`${tenant.slug}:${slug}`] = created.json().id as string;
      }
    }
    await grantRole(db, org, systems['upg:isms']!, mm, 'ms_manager');
    await grantRole(db, demo, systems['dmo:isms']!, demoMm, 'ms_manager');
    isoVersionId = (await sql<{ id: string }>`select id from ref.framework_version where pack_id = 'ISO27001-2022'`.execute(db.migrator)).rows[0]!.id;

    // An open certification cycle of the ISMS with the items of the installed edition (M2-05 creates them on screen).
    await tenantRows(org, async (trx) => {
      const cycle = await trx
        .insertInto('certification_cycle')
        .values({ management_system_id: systems['upg:isms']!, cycle_start: '2026-01-01', cycle_end: '2029-01-01', status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await sql`
        insert into cycle_requirement_status (management_system_id, certification_cycle_id, cycle_requirement_def_id, requirement_code, title, due_at, position)
        select ${systems['upg:isms']}, ${cycle.id}, d.id, coalesce(d.requirement_code, '-'), d.title, date '2026-12-01', d.sort_order
          from ref.cycle_requirement_def d where d.framework_version_id = ${isoVersionId}`.execute(trx);
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('seeds the D2-09 entries of a system once: every Annex A control and every leaf clause row, applicable and not started', async () => {
    const scope = app.moduleRef.get(TenantScope);
    const results = [];
    for (const [tenant, key] of [[org, 'upg:isms'], [org, 'upg:qms'], [demo, 'dmo:isms']] as const) {
      results.push(await scope.withTenant(systemContextOf({ id: tenant.id, schema: tenant.schemaName }), (trx) => seedApplicability(trx, systems[key]!)));
    }
    expect(results.map((r) => [r.added.length, r.existing])).toEqual([[93 + 24, 0], [28, 0], [93 + 24, 0]]);
    expect(results[0]!.added.slice(0, 2).map((e) => [e.targetType, e.code])).toEqual([['catalogue_item', 'A.5.1'], ['catalogue_item', 'A.5.2']]);
    expect(results[0]!.added.at(-1)).toMatchObject({ targetType: 'requirement', code: '10.3' });
    const entries = await tenantRows(org, (trx) =>
      trx.selectFrom('applicability_entry').select(['is_applicable', 'implementation_status', 'owner_user_id', 'holds_gate']).where('management_system_id', '=', systems['upg:isms']!).execute(),
    );
    expect(new Set(entries.map((e) => JSON.stringify(e)))).toEqual(new Set([JSON.stringify({ is_applicable: true, implementation_status: 'not_started', owner_user_id: null, holds_gate: false })]));
    // A second call finds every target and adds nothing.
    const again = await scope.withTenant(systemContextOf({ id: org.id, schema: org.schemaName }), (trx) => seedApplicability(trx, systems['upg:isms']!));
    expect([again.added.length, again.existing]).toEqual([0, 117]);
  });

  it('refuses a version that drops a code without retiring it (422 PACK-ROW-REMOVED), at the import and in the installer', async () => {
    const before = { ref: await refRowCounts(db), installs: (await sql`select id from platform.pack_install`.execute(db.migrator)).rows.length };
    const dropped = version('1.2.2', (s) => editCsv(s, 'requirements.csv', (rows) => rows.filter((r) => r.requirement_code !== '10.3')));
    const response = await postImport(app, 'ta@upg', dropped.bytes);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      type: 'https://mscd.cyberlentera.com/problems/business-rule',
      rule: 'PACK-ROW-REMOVED',
      messageKey: 'pack.row_removed',
      affected: ['10.3'],
      messages: { en: expect.stringContaining('10.3'), id: expect.stringContaining('10.3') },
    });
    expect(app.queue.waitingJobs('pack.install')).toHaveLength(0);

    const droppedItem = version('1.2.2', (s) => editCsv(s, 'catalogue.csv', (rows) => rows.filter((r) => r.item_code !== 'A.8.34')));
    let caught: unknown;
    try {
      await testInstaller(db.packInstaller).install(droppedItem.bytes, { actor: OPERATOR });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PackRejectedError);
    expect(caught).toMatchObject({ code: 'row_removed', status: 422, issues: [expect.stringContaining('catalogue.csv: A.8.34 is installed')] });
    expect(await refRowCounts(db)).toEqual(before.ref);
    expect((await sql`select id from platform.pack_install`.execute(db.migrator)).rows.length).toBe(before.installs);
    const rejected = await inScope(db.migrator, { platformScope: true }, async (trx) =>
      (await sql<{ after_data: { reason: string } }>`select after_data from platform.audit_log where action = 'pack.rejected' order by seq`.execute(trx)).rows,
    );
    expect(rejected.map((r) => r.after_data.reason)).toEqual(['row_removed', 'row_removed']);
  });

  it('installs an update, keeps every row, and adds its content to the systems on the edition once', async () => {
    const before = await refRowCounts(db);
    const ismsBefore = await entryCodes(org, systems['upg:isms']!);
    const response = await postImport(app, 'ta@upg', version('1.2.2', fixtureChanges).bytes);
    expect(response.statusCode, response.body).toBe(202);
    await app.runJobs();

    // ref: nothing deleted, 10.3 retired, 10.1 retitled, 9.2.1 added under 9.2, one cycle requirement more.
    expect(await refRowCounts(db)).toEqual({ ...before, requirements: before.requirements + 1, cycle_requirements: before.cycle_requirements + 1 });
    const rows = await sql<{ requirement_code: string; title_short: string; retired: boolean; parent: string | null }>`
      select r.requirement_code, r.title_short, r.retired, p.requirement_code as parent from ref.requirement r
        left join ref.requirement p on p.id = r.parent_id
       where r.framework_version_id = ${isoVersionId} and r.requirement_code in ('9.2', '9.2.1', '10.1', '10.3') order by r.sort_order`.execute(db.migrator);
    expect(rows.rows).toEqual([
      { requirement_code: '9.2', title_short: 'Internal audit', retired: false, parent: null },
      { requirement_code: '9.2.1', title_short: 'Internal audit programme', retired: false, parent: '9.2' },
      { requirement_code: '10.1', title_short: 'Continual improvement', retired: false, parent: null },
      { requirement_code: '10.3', title_short: 'Continual improvement', retired: true, parent: null },
    ]);
    // The target list of the edition: 10.3 (retired) and 9.2 (no longer a leaf) are out, 9.2.1 is in.
    const targets = await inScope(db.migrator, {}, (trx) => seedTargets(trx, isoVersionId));
    const targetCodes = targets.map((t) => t.code);
    expect(targetCodes).toContain('9.2.1');
    expect(targetCodes).not.toContain('10.3');
    expect(targetCodes).not.toContain('9.2');
    // 24 clause rows: 10.3 retired and 9.2 with a child leave, 9.2.1 joins.
    expect(targets).toHaveLength(93 + 23);

    // The change summary of the installation.
    const installed = await inScope(db.migrator, { platformScope: true }, async (trx) =>
      (await sql<{ after_data: { changes: Record<string, string[]> } }>`
        select after_data from platform.audit_log where action = 'pack.installed' and entity_code = 'ISO27001-2022 1.2.2'`.execute(trx)).rows,
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]!.after_data.changes).toEqual({
      added: ['9.2.1'], retitled: ['10.1'], retired: ['10.3'], restored: [], cycleRequirementsAdded: ['FIXTURE_ITEM'], activitiesDropped: [], prepTasksDropped: [],
    });

    // The ISMS of the organisation: one entry more, every earlier entry kept (also on 10.3 and on 9.2).
    const ismsAfter = await entryCodes(org, systems['upg:isms']!);
    expect(ismsAfter).toEqual([...ismsBefore, '9.2.1']);
    expect(ismsAfter).toEqual(expect.arrayContaining(['10.3', '9.2']));
    // The open cycle got the new item, owned by the primary MS Manager and due at the cycle end (no audit event).
    const items = await tenantRows(org, (trx) =>
      trx.selectFrom('cycle_requirement_status').select(['requirement_code', 'title', 'owner_user_id', 'status', 'due_at']).where('management_system_id', '=', systems['upg:isms']!).orderBy('position').execute(),
    );
    expect(items).toHaveLength(7);
    expect(items.at(-1)).toEqual({ requirement_code: '9.2', title: 'Audit programme confirmed for the cycle', owner_user_id: mm, status: 'not_started', due_at: '2029-01-01' });

    // One notice for the MS Manager, one audit entry for the system.
    const sent = await notices(org, mm);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ management_system_id: systems['upg:isms'], title_en: 'ISMS: framework content updated to ISO27001-2022 1.2.2' });
    expect(sent[0]!.body_en).toBe(
      '1 new entry: 9.2.1. New titles: 10.1. No longer in the standard: 10.3. Their entries stay and are marked as such. New certification cycle items: FIXTURE_ITEM. New entries start as not started and without an owner.',
    );
    expect(sent[0]!.body_id).toContain('Tidak lagi ada dalam standar: 10.3.');
    const audited = await synced();
    expect(audited).toEqual([
      expect.objectContaining({
        organization_id: org.id,
        management_system_id: systems['upg:isms'],
        edition: 'ISO27001-2022 1.2.2',
        after_data: expect.objectContaining({ pack_version: '1.2.2', entries_added: 1, added: ['9.2.1'], retitled: ['10.1'], retired: ['10.3'], cycle_items_added: ['FIXTURE_ITEM'] }),
      }),
    ]);
    // The new entries are queued for freshness and readiness (debounced, so they wait).
    expect(app.queue.waitingJobs('readiness.recompute').map((j) => j.env.payload)).toEqual([{ msId: systems['upg:isms'] }]);

    // Other systems are untouched: the QMS is on another edition, the demo organisation is skipped.
    expect(await entryCodes(org, systems['upg:qms']!)).toHaveLength(28);
    expect(await entryCodes(demo, systems['dmo:isms']!)).toHaveLength(117);
    expect(await notices(demo, demoMm)).toEqual([]);
    expect(app.queue.completed('applicability.sync').map((j) => j.env.orgId)).toEqual([org.id]);
  });

  it('adds nothing on a second run, and never syncs a demo organisation', async () => {
    const entries = await entryCodes(org, systems['upg:isms']!);
    expect(await sync().sync(org.id, { frameworkVersionIds: [isoVersionId] })).toEqual({ systems: [] });
    expect(await sync().queuePending()).toEqual({ organisations: [] });
    expect(await sync().sync(demo.id, { frameworkVersionIds: [isoVersionId] })).toEqual({ skipped: 'demo', systems: [] });
    await app.runJobs();
    expect(await entryCodes(org, systems['upg:isms']!)).toEqual(entries);
    expect(await entryCodes(demo, systems['dmo:isms']!)).toHaveLength(117);
    expect(await notices(org, mm)).toHaveLength(1);
    expect(await notices(demo, demoMm)).toEqual([]);
    expect(await synced()).toHaveLength(1);
  });

  it('accepts a version that drops an activity template: the template stays installed and activity copies are unchanged', async () => {
    const before = await refRowCounts(db);
    const copies = await tenantRows(org, (trx) => trx.selectFrom('implementation_activity_progress').select(['phase_no', 'activity_no', 'title']).where('management_system_id', '=', systems['upg:isms']!).execute());
    const dropped = version('1.2.3', fixtureChanges, (s) => editCsv(s, 'activities.csv', (rows) => rows.filter((r) => !(r.phase_no === '9' && r.activity_no === '7'))));
    const outcome = await testInstaller(db.packInstaller).install(dropped.bytes, { actor: OPERATOR });
    expect(outcome).toMatchObject({ status: 'installed', version: '1.2.3', updatedEdition: true, previousVersion: '1.2.2' });
    expect(outcome.status === 'installed' && outcome.changes).toEqual({
      added: [], retitled: [], retired: [], restored: [], cycleRequirementsAdded: [], activitiesDropped: ['9.7'], prepTasksDropped: [],
    });
    expect(await refRowCounts(db)).toEqual(before);
    const kept = await sql<{ title: string }>`select title from ref.activity_template where framework_version_id = ${isoVersionId} and phase_no = 9 and activity_no = 7`.execute(db.migrator);
    expect(kept.rows).toEqual([{ title: 'Close-out of open actions' }]);
    expect(await tenantRows(org, (trx) => trx.selectFrom('implementation_activity_progress').select(['phase_no', 'activity_no', 'title']).where('management_system_id', '=', systems['upg:isms']!).execute())).toEqual(copies);
  });

  it('picks up an installation made outside the worker (migrate, packs install) with queuePending', async () => {
    // The installation above ran outside the worker: nothing was queued. The reconciliation finds the system waiting.
    expect(app.queue.waitingJobs('applicability.sync')).toHaveLength(0);
    expect(await sync().queuePending()).toEqual({ organisations: [org.id] });
    await app.runJobs();
    // 1.2.3 changed no row a system holds: an audit entry, no entry and no notice.
    expect((await synced()).map((s) => (s.after_data as { pack_version: string }).pack_version)).toEqual(['1.2.2', '1.2.3']);
    expect(await notices(org, mm)).toHaveLength(1);

    const another = version('1.2.4', fixtureChanges, (s) => {
      editCsv(s, 'activities.csv', (rows) => rows.filter((r) => !(r.phase_no === '9' && r.activity_no === '7')));
      editCsv(s, 'requirements.csv', (rows) => {
        rows.push({ ...rows.find((r) => r.requirement_code === '9.3')!, requirement_code: '9.3.1', parent_code: '9.3', title_short: 'Management review inputs', is_hs_common: 'false' });
        return rows.sort(byCode).map((r, i) => ({ ...r, sort_order: String(i + 1) }));
      });
    });
    expect(await testInstaller(db.packInstaller).install(another.bytes, { actor: OPERATOR })).toMatchObject({ status: 'installed', version: '1.2.4' });
    expect(await sync().queuePending({ frameworkVersionIds: [isoVersionId] })).toEqual({ organisations: [org.id] });
    await app.runJobs();
    expect((await entryCodes(org, systems['upg:isms']!)).slice(-2)).toEqual(['9.2.1', '9.3.1']);
    const sent = await notices(org, mm);
    expect(sent).toHaveLength(2);
    expect(sent.map((n) => n.title_en)).toContain('ISMS: framework content updated to ISO27001-2022 1.2.4');
    expect(await sync().queuePending()).toEqual({ organisations: [] });
    expect(await entryCodes(demo, systems['dmo:isms']!)).toHaveLength(117);
  });
});
