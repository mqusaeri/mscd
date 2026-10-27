// Read model loader additions (Milestone 2 D.3, D.6, D2-09, M2-07): a clause entry of a catalogue system has the key
// `cl-<code>` and never shares a key with the control of the same number; stored readiness rows pass through with
// their nulls and four dimensions; certification cycles come with their certificate, newest first.
import type { UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedApplicability } from '../../../src/modules/implementation/applicability-seed';
import { entryKey } from '../../../src/modules/read-model/derive/requirements';
import { loadOrgData } from '../../../src/modules/read-model/load/loader';
import { useTestDatabase } from '../../setup/test-db';
import { createExtraApp, inOrg, rowsOf, sessionFor, systemOf, type Client, type CommandsApp, type DemoOrg } from './helpers';

describe('read model loader additions (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let isms: { id: string; version: string };

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('keys a clause entry of a catalogue system cl-<code>, apart from the control of the same number (D2-09)', async () => {
    const created = await rina.post('/api/v1/ms/isms/applicability', {
      targetType: 'requirement', code: '5.1', isApplicable: true, inclusionJustification: 'Leadership commitment is audited', ownerHandle: 'rina', frequencyCode: 'annual',
    });
    expect(created.status).toBe(201);
    const { reqs } = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle;
    expect(new Set(reqs.map((r) => r.key)).size).toBe(reqs.length);
    expect(new Set(reqs.map((r) => r.id)).size).toBe(reqs.length);
    expect(reqs.find((r) => r.id === 'Cl. 5.1')).toMatchObject({ key: 'cl-5.1' });
    const control = reqs.find((r) => r.id === 'A.5.1');
    if (control) expect(control.key).toBe('5.1');
    // Controls keep their Milestone 1 keys.
    expect(reqs.filter((r) => r.id.startsWith('A.')).every((r) => !r.key.startsWith('cl-') && !r.key.startsWith('A.'))).toBe(true);
  });

  it('marks an entry whose row is no longer in the standard as retired (E.1)', async () => {
    const entryOf = async () => {
      const data = await inOrg(db, 'tst', (trx) => loadOrgData(trx, { slugs: ['isms'], bundle: true }));
      return data.systems[0]!.bundle!.entries.find((e) => e.targetType === 'requirement' && e.code === '5.1')!;
    };
    expect(await entryOf()).toMatchObject({ retired: false, catalogueSystem: true });
    await inOrg(db, 'tst', (trx) => sql`update ref.requirement set retired = true where framework_version_id = ${isms.version} and requirement_code = '5.1'`.execute(trx));
    try {
      expect(await entryOf()).toMatchObject({ retired: true });
    } finally {
      await inOrg(db, 'tst', (trx) => sql`update ref.requirement set retired = false where framework_version_id = ${isms.version} and requirement_code = '5.1'`.execute(trx));
    }
  });

  it('gives every entry of every seeded demo system its own key', async () => {
    for (const org of ['ndt', 'bsd', 'rmn', 'tst'] as DemoOrg[]) {
      const data = await inOrg(db, org, (trx) => loadOrgData(trx, { bundle: true }));
      for (const system of data.systems) {
        const keys = (system.bundle?.entries ?? []).map((e) => entryKey(e));
        expect(new Set(keys).size, `${org}/${system.slug}`).toBe(keys.length);
      }
    }
  });

  it('gives every entry of an ISO 27001 system seeded with all its controls and clause rows its own key', async () => {
    const isms = await systemOf(db, 'ndt', 'isms');
    const seeded = await inOrg(db, 'ndt', (trx) => seedApplicability(trx, isms.id));
    expect(seeded.added.some((e) => e.targetType === 'requirement')).toBe(true);
    const ndtRina = await sessionFor(ctx, db, 'rina', 'ndt');
    const { reqs } = (await ndtRina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle;
    const [{ n: live }] = await rowsOf<{ n: number }>(db, 'ndt', sql`
      select count(*)::int as n from applicability_entry where management_system_id = ${isms.id} and deleted_at is null`) as [{ n: number }];
    expect(reqs).toHaveLength(live);
    expect(new Set(reqs.map((r) => r.key)).size).toBe(reqs.length);
    const clauses = reqs.filter((r) => r.id.startsWith('Cl. '));
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) expect(clause.key).toBe(`cl-${clause.id.slice(4)}`);
  });

  it('passes stored readiness rows through with nulls and the four dimensions (D.6)', async () => {
    await inOrg(db, 'tst', (trx) => sql`
      update clause_readiness set readiness_pct = null, documented_pct = 40, implemented_pct = null, evidenced_pct = 25, measured_pct = null,
             computed_at = timestamptz '2026-09-28T02:00:00Z', source = 'computed'
       where management_system_id = ${isms.id} and clause_group = 4 and deleted_at is null`.execute(trx));
    const data = await inOrg(db, 'tst', (trx) => loadOrgData(trx, { slugs: ['isms'], bundle: false }));
    const system = data.systems.find((s) => s.slug === 'isms')!;
    expect(system.readiness.get(4)).toEqual({
      readiness: null, documented: 40, implemented: null, evidenced: 25, measured: null, computedAt: new Date('2026-09-28T02:00:00Z'), source: 'computed',
    });
    const stored = await rowsOf<{ clause_group: number; readiness_pct: number | null }>(db, 'tst', sql`
      select clause_group, readiness_pct from clause_readiness where management_system_id = ${isms.id} and deleted_at is null and clause_group <> 4`);
    for (const row of stored) expect(system.readiness.get(row.clause_group)?.readiness).toBe(row.readiness_pct);
    expect((await rina.get('/api/v1/ui/ms/isms')).status).toBe(200);
  });

  it('loads the certification cycles with their certificate, newest first (D.4)', async () => {
    await inOrg(db, 'tst', (trx) => sql`
      update certification_cycle set certificate_no = 'CERT-27001-0042', certified_at = date '2024-10-01', certificate_expires_at = date '2027-09-30',
             certification_body = 'Example Certification Body', certified_scope = 'Head office and data centre'
       where id = (select id from certification_cycle where management_system_id = ${isms.id} and deleted_at is null order by cycle_start desc, created_at desc limit 1)`.execute(trx));
    const data = await inOrg(db, 'tst', (trx) => loadOrgData(trx, { slugs: ['isms'], bundle: false }));
    const { cycles } = data.systems.find((s) => s.slug === 'isms')!;
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toMatchObject({
      certificateNo: 'CERT-27001-0042', certifiedAt: '2024-10-01', certificateExpiresAt: '2027-09-30', certificationBody: 'Example Certification Body',
      certifiedScope: 'Head office and data centre',
    });
    const starts = cycles.map((c) => c.cycleStart);
    expect([...starts].sort().reverse()).toEqual(starts);
  });
});
