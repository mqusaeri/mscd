// Clause readiness (Milestone 2 D.6, M2-05) and the derived cycle items (D.4) on a copy of the demo template:
// `readiness.recompute` leaves the demo's manual rows alone, gives a fresh system with no rows null per group, and
// rises after an entry is verified (the command queues the job next to freshness.recompute); the overview and card
// derivations read stored dimensions and keep the Milestone 1 formula for rows without them; the new derivation kinds
// of `cycle.derive`.
import { ManagementSystem } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READINESS_GROUPS, groupOfCode, readinessOf, share } from '../../../src/modules/implementation/readiness/readiness.service';
import { readinessRecomputeKey } from '../../../src/modules/implementation/readiness/readiness-queue';
import {
  certificateLabelOf, deriveManagementSystem, newestCertificate, NOT_CERTIFIED, type CertificateCycle, type MsFieldsInput,
} from '../../../src/modules/read-model/derive/ms-fields';
import { clauseDimensions, clauseMaturity, maturityLevel, maturityValues } from '../../../src/modules/read-model/derive/overview';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import {
  addDocument, createCertApp, entriesWithStatus, entryOf, grantRole, inOrg, ORG_IDS, rowsOf, sessionFor, systemOf, TODAY, type CertApp, type Client, type DemoOrg,
} from './helpers';

interface StoredRow {
  clause_group: number;
  readiness_pct: number | null;
  documented_pct: number | null;
  implemented_pct: number | null;
  evidenced_pct: number | null;
  measured_pct: number | null;
  source: string;
  computed_at: Date | null;
}

describe('clause readiness and derived cycle items (Milestone 2 D.6, D.4)', () => {
  const db = useTestDatabase('demo');
  let ctx: CertApp;
  let hendra: Client;

  beforeAll(async () => {
    ctx = await createCertApp(db);
    // A Programme Owner verifies entries (applicability.verify), as in the WP-20 tests.
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const storedOf = (org: DemoOrg, msId: string) =>
    rowsOf<StoredRow>(db, org, sql`
      select clause_group, readiness_pct, documented_pct, implemented_pct, evidenced_pct, measured_pct, source, computed_at
        from clause_readiness where management_system_id = ${msId} and deleted_at is null order by clause_group`);

  describe('readiness.recompute', () => {
    it('leaves manual rows alone: the demo keeps its sample readiness', async () => {
      const isms = await systemOf(db, 'tst', 'isms');
      const before = await storedOf('tst', isms.id);
      expect(before.map((r) => r.source)).toEqual(Array(7).fill('manual'));
      const result = await ctx.readiness('tst', isms.id);
      expect(result).toEqual([expect.objectContaining({ msId: isms.id, slug: 'isms', manual: [...READINESS_GROUPS] })]);
      expect(await storedOf('tst', isms.id)).toEqual(before);
      expect(before.every((r) => r.computed_at === null && r.documented_pct === null)).toBe(true);
    });

    it('gives a fresh system with no rows a null readiness and null dimensions per group, stored as computed', async () => {
      // A system on an edition without content, with no entries, documents, evidence or metrics.
      const repository = (await rowsOf<{ id: string }>(db, 'tst', sql`select id from storage_repository where deleted_at is null order by created_at limit 1`))[0]!.id;
      const { rows: framework } = await sql<{ id: string }>`
        insert into ref.framework (code, name) values ('FXT', 'Fixture standard') returning id`.execute(db.migrator);
      const { rows: version } = await sql<{ id: string }>`
        insert into ref.framework_version (framework_id, edition, pack_id, pack_version, status, applicability_target, pack_checksum, manifest)
        values (${framework[0]!.id}, '2026', 'FXT-2026', '0.0.1', 'current', 'requirement', ${'0'.repeat(64)}, '{}'::jsonb) returning id`.execute(db.migrator);
      const msId = await inOrg(db, 'tst', async (trx) => (await sql<{ id: string }>`
        insert into management_system (slug, code, name, framework_version_id, scope_statement, status, default_storage_repository_id)
        values ('fresh', 'FRESH', 'Fresh system', ${version[0]!.id}, 'Head office', 'implementing', ${repository}) returning id`.execute(trx)).rows[0]!.id);
      const [result] = await ctx.readiness('tst', msId);
      expect(result!.groups).toEqual(READINESS_GROUPS.map((group) => ({ group, readiness: null, documented: null, implemented: null, evidenced: null, measured: null })));
      expect(result!.manual).toEqual([]);
      const stored = await storedOf('tst', msId);
      expect(stored.map((r) => [r.clause_group, r.readiness_pct, r.source])).toEqual(READINESS_GROUPS.map((g) => [g, null, 'computed']));
      expect(stored.every((r) => r.computed_at !== null)).toBe(true);
      // A second run updates the same seven rows.
      await ctx.readiness('tst', msId);
      expect(await storedOf('tst', msId)).toHaveLength(7);
      // The daily run covers every system of the organisation.
      expect((await ctx.readiness('tst')).map((s) => s.slug).sort()).toEqual(['fresh', 'isms']);
    });

    it('rises after an entry is verified: the command queues readiness.recompute, and the run raises implemented', async () => {
      const isms = await systemOf(db, 'tst', 'isms');
      // The demo rows are manual; without them the system's readiness is computed.
      await inOrg(db, 'tst', (trx) => sql`update clause_readiness set deleted_at = now() where management_system_id = ${isms.id}`.execute(trx));
      const [baseline] = await ctx.readiness('tst', isms.id);
      const groupOf = async (code: string) => {
        const [row] = await rowsOf<{ grp: string }>(db, 'tst', sql`
          select coalesce(rq.clause_group, '8') as grp from ref.catalogue_item ci left join ref.requirement rq on rq.id = ci.requirement_id
           where ci.framework_version_id = ${isms.editionId} and ci.item_code = ${code}`);
        return Number(row!.grp);
      };
      const entry = (await entriesWithStatus(db, 'tst', 'isms', 'partially_implemented'))[1]!;
      const group = await groupOf(entry.code);
      const before = baseline!.groups.find((g) => g.group === group)!;
      const [counts] = await rowsOf<{ total: number; done: number }>(db, 'tst', sql`
        select count(*)::int as total,
               count(*) filter (where e.implementation_status in ('implemented', 'not_applicable') or e.is_applicable is false)::int as done
          from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id left join ref.requirement rq on rq.id = ci.requirement_id
         where e.management_system_id = ${isms.id} and e.deleted_at is null and not ci.retired and coalesce(rq.clause_group, '8') = ${String(group)}`);
      expect(before.implemented).toBe(share(counts!.done, counts!.total));
      expect(before.readiness).toBe(readinessOf([before.documented, before.implemented, before.evidenced, before.measured]));

      // One intact, fresh evidence item for the entry (BR-01), then a Top Management verification.
      await inOrg(db, 'tst', async (trx) => {
        const { rows } = await sql<{ id: string; storage_object_id: string }>`
          select id, storage_object_id from evidence where deleted_at is null and storage_object_id is not null order by evidence_code limit 1`.execute(trx);
        const target = (await sql<{ catalogue_item_id: string }>`select catalogue_item_id from applicability_entry where id = ${entry.id}`.execute(trx)).rows[0]!;
        await sql`update evidence_target set deleted_at = now() where applicability_entry_id = ${entry.id}`.execute(trx);
        await sql`insert into evidence_target (evidence_id, management_system_id, applicability_entry_id, target_type, catalogue_item_id)
                  values (${rows[0]!.id}, ${isms.id}, ${entry.id}, 'catalogue_item', ${target.catalogue_item_id}) on conflict do nothing`.execute(trx);
        await sql`update evidence set produced_at = date '2026-09-01', frequency_code = 'monthly' where id = ${rows[0]!.id}`.execute(trx);
        await sql`update storage_object set link_status = 'intact', link_status_since = now() where id = ${rows[0]!.storage_object_id}`.execute(trx);
      });
      const verified = await hendra.post(`/api/v1/ms/isms/applicability/${entry.id}/transitions`, { to: 'implemented' });
      expect(verified.status).toBe(200);
      expect((await entryOf(db, 'tst', 'isms', entry.code)).status).toBe('implemented');
      // Queued in the command's transaction next to freshness.recompute, with cycle.derive (D.6).
      const payloadMs = (j: { env: { payload: unknown } }) => (j.env.payload as { msId?: string }).msId;
      const queued = ctx.queue.waitingJobs('readiness.recompute').filter((j) => j.env.orgId === ORG_IDS.tst && payloadMs(j) === isms.id);
      expect(queued).toHaveLength(1);
      expect(ctx.queue.waitingJobs('cycle.derive').map((j) => j.env.payload)).toContainEqual({ msId: isms.id });
      expect(ctx.queue.waitingJobs('freshness.recompute').map(payloadMs)).toContain(isms.id);
      expect(readinessRecomputeKey(ORG_IDS.tst, isms.id)).toBe(`rr:${ORG_IDS.tst}:${isms.id}`);

      const [after] = await ctx.readiness('tst', isms.id);
      const now = after!.groups.find((g) => g.group === group)!;
      expect(now.implemented).toBe(share(counts!.done + 1, counts!.total));
      expect(now.implemented!).toBeGreaterThan(before.implemented!);
      const stored = (await storedOf('tst', isms.id)).find((r) => r.clause_group === group)!;
      expect(stored).toMatchObject({ source: 'computed', implemented_pct: now.implemented, readiness_pct: now.readiness });
      // Group 9 alone has a measured dimension.
      expect(after!.groups.filter((g) => g.group !== 9).every((g) => g.measured === null)).toBe(true);
    });

    it('counts documented information in place: an approved document by template code or by its code link, not past review', async () => {
      const isms = await systemOf(db, 'tst', 'isms');
      await sql`insert into ref.documented_info (framework_version_id, code, requirement_code, kind, title, template_code, sort_order)
                values (${isms.editionId}, 'DI-FX-01', '5.2', 'maintain', 'Fixture policy', 'POL-FX-RD', 901),
                       (${isms.editionId}, 'DI-FX-02', '5.3', 'maintain', 'Fixture roles', null, 902)`.execute(db.packInstaller);
      const documented = async (group: number) => (await ctx.readiness('tst', isms.id))[0]!.groups.find((g) => g.group === group)!.documented;
      const before = await documented(5);
      // By template code: a draft does not count, an approved one does, one past its review date does not.
      const policy = await addDocument(db, 'tst', 'isms', { code: 'POL-FX-RD', type: 'policy', status: 'draft' });
      expect(await documented(5)).toBe(before);
      await inOrg(db, 'tst', (trx) => sql`update document set status = 'approved', approved_at = date '2026-09-01', next_review_at = date '2027-09-01' where id = ${policy}`.execute(trx));
      const withPolicy = await documented(5);
      expect(withPolicy!).toBeGreaterThan(before ?? 0);
      await inOrg(db, 'tst', (trx) => sql`update document set next_review_at = date '2026-09-01' where id = ${policy}`.execute(trx));
      expect(await documented(5)).toBe(before);
      // By the system's code link of the row code.
      const roles = await addDocument(db, 'tst', 'isms', { code: 'ROLES-77', type: 'standard' });
      await inOrg(db, 'tst', (trx) => sql`insert into document_code_link (management_system_id, pack_code, document_id) values (${isms.id}, 'DI-FX-02', ${roles})`.execute(trx));
      expect((await documented(5))!).toBeGreaterThan(before ?? 0);
    });

    it('computes the dimensions from their shares', () => {
      expect(share(1, 3)).toBe(33);
      expect(share(0, 0)).toBeNull();
      expect(readinessOf([80, null, 60, null])).toBe(70);
      expect(readinessOf([null, null, null, null])).toBeNull();
      expect(groupOfCode('7.5.3')).toBe(7);
      expect(groupOfCode('A.5.1')).toBeNull();
      expect(groupOfCode('11.1')).toBeNull();
    });
  });

  describe('overview and card fields', () => {
    const base: Omit<MsFieldsInput, 'readiness'> = {
      slug: 'fresh', code: 'FRESH', scope: 'Head office', certificationBody: null, color: '#3a6fd8', display: {},
      active: {
        id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d', frameworkCode: 'ISO27001', frameworkName: 'ISO/IEC 27001', edition: '2022', packId: 'ISO27001-2022',
        packVersion: '1.3.0', status: 'current', preRelease: false, applicabilityTarget: 'catalogue_item', installedAt: new Date('2026-10-01T00:00:00Z'),
      },
      target: null, labels: {}, primaryManager: null, nextEvent: null, findings: { open: 0, major: 0 }, alerts: [],
      defaultRepository: { slug: 'vault', adapter: 'managed_vault' }, defaultRoutingMode: null, approver: null,
    };

    it('shows null readiness while not computed, stored dimensions once computed, and the Milestone 1 fields for manual rows', () => {
      const fresh = deriveManagementSystem({ ...base, readiness: new Map() });
      expect(fresh.clauses).toEqual([null, null, null, null, null, null, null]);
      expect(fresh.readiness).toBeUndefined();
      expect(fresh.cert).toEqual(NOT_CERTIFIED);
      expect(ManagementSystem.safeParse(fresh).success).toBe(true);

      const computedAt = new Date('2026-10-28T02:30:00Z');
      const computed = deriveManagementSystem({
        ...base,
        readiness: new Map(READINESS_GROUPS.map((g) => [g, { readiness: g === 9 ? 55 : null, documented: g === 9 ? 40 : null, implemented: g === 9 ? 70 : null, evidenced: null, measured: g === 9 ? null : null, computedAt }])),
      });
      expect(computed.clauses).toEqual([null, null, null, null, null, 55, null]);
      expect(computed.readiness).toEqual({
        computedAt: '2026-10-28T02:30:00.000Z',
        groups: READINESS_GROUPS.map((g) => ({ documented: g === 9 ? 40 : null, implemented: g === 9 ? 70 : null, evidenced: null, measured: null })),
      });
      expect(ManagementSystem.safeParse(computed).success).toBe(true);

      // The demo: bare percentages (Milestone 1 loader) or manual rows without dimensions keep the Milestone 1 output.
      const manual = deriveManagementSystem({ ...base, display: { certLabel: ['Certified 14 Mar 2025, cycle 2025–2028', 'x'] }, readiness: new Map(READINESS_GROUPS.map((g) => [g, 88])) });
      expect(manual.clauses).toEqual(Array(7).fill(88));
      expect(manual.readiness).toBeUndefined();
      expect(manual.cert).toEqual(['Certified 14 Mar 2025, cycle 2025–2028', 'x']);
    });

    it('labels the certificate from the newest cycle that holds one when the cycles are given, else from the stored label', () => {
      const cycle = (status: CertificateCycle['status'], certifiedAt: string | null, expiresAt: string | null, cycleStart = '2025-03-14'): CertificateCycle =>
        ({ status, cycleStart, cycleEnd: '2028-03-14', certifiedAt, certificateExpiresAt: expiresAt });
      const certified = cycle('certified', '2025-03-14', '2028-03-13');
      expect(certificateLabelOf(certified)).toEqual(['Certified 14 Mar 2025, cycle 2025\u20132028', 'Tersertifikasi 14 Mar 2025, siklus 2025\u20132028']);
      expect(certificateLabelOf(certified, '2028-03-13')![0]).toMatch(/^Certified/);
      expect(certificateLabelOf(certified, '2028-03-14')).toEqual(['Certificate expired', 'Sertifikat kedaluwarsa']);
      expect(certificateLabelOf(cycle('suspended', '2025-03-14', '2028-03-13'))).toEqual(['Certificate suspended', 'Sertifikat dibekukan']);
      expect(certificateLabelOf(cycle('active', null, null))).toBeNull();
      // The next certificate replaces the closed one; a planned or active cycle holds none.
      const next = cycle('certified', '2028-02-20', '2031-02-19', '2027-11-01');
      expect(newestCertificate([cycle('active', null, null, '2030-01-01'), next, cycle('closed', '2025-03-14', '2028-03-13')])).toBe(next);
      const stored = ['Not yet certified, Stage 1 planned', 'Belum tersertifikasi, Tahap 1 direncanakan'] as [string, string];
      expect(deriveManagementSystem({ ...base, readiness: new Map(), display: { certLabel: stored }, cycles: [cycle('planned', null, null, '2026-01-01')], today: TODAY }).cert).toEqual(stored);
      expect(deriveManagementSystem({ ...base, readiness: new Map(), display: { certLabel: stored }, cycles: [next], today: TODAY }).cert[0]).toBe('Certified 20 Feb 2028, cycle 2028\u20132031');
    });

    it('reads the four stored dimensions, and keeps the offset formula of maturityValues for rows without them', () => {
      expect(clauseDimensions(72, 2)).toEqual(maturityValues(72, 2));
      expect(clauseDimensions({ readiness: 72, documented: null, implemented: null, evidenced: null, measured: null, computedAt: null }, 0)).toEqual(maturityValues(72, 0));
      expect(clauseDimensions({ readiness: 60, documented: 80, implemented: 40, evidenced: null, measured: null, computedAt: '2026-10-28T02:30:00Z' }, 3)).toEqual([80, 40, null, null]);
      expect(clauseDimensions(null, 0)).toEqual([null, null, null, null]);
      expect(clauseMaturity(6, 88, 0)).toEqual({ clause: 6, readiness: 88, dimensions: maturityValues(88, 0).map(maturityLevel) });
      expect(clauseMaturity(9, null, 0)).toEqual({ clause: 9, readiness: null, dimensions: [null, null, null, null] });
      expect(clauseMaturity(5, { readiness: 60, documented: 80, implemented: 40, evidenced: 75, measured: null, computedAt: '2026-10-28T02:30:00Z' }, 1))
        .toEqual({ clause: 5, readiness: 60, dimensions: [3, 2, 3, null], computedAt: '2026-10-28T02:30:00.000Z' });
    });
  });

  describe('cycle.derive kinds of Milestone 2', () => {
    /** Sets `kind` on a cycle requirement of the system's current cycle, resets the item, derives, and returns whether it is met. */
    const derive = async (org: DemoOrg, ms: string, derivation: Record<string, unknown>): Promise<boolean> => {
      const system = await systemOf(db, org, ms);
      const [item] = await rowsOf<{ id: string; code: string }>(db, org, sql`
        with current_cycle as (select id from certification_cycle where management_system_id = ${system.id} and deleted_at is null
                                order by cycle_start desc, created_at desc limit 1)
        select s.id, d.code from cycle_requirement_status s join ref.cycle_requirement_def d on d.id = s.cycle_requirement_def_id
         where s.certification_cycle_id = (select id from current_cycle) and s.deleted_at is null order by s.position limit 1`);
      await sql`update ref.cycle_requirement_def set derivation = null where framework_version_id = ${system.editionId}`.execute(db.packInstaller);
      await sql`update ref.cycle_requirement_def set derivation = ${JSON.stringify(derivation)}::jsonb
                 where framework_version_id = ${system.editionId} and code = ${item!.code}`.execute(db.packInstaller);
      await inOrg(db, org, (trx) => sql`update cycle_requirement_status set status = 'in_progress' where id = ${item!.id}`.execute(trx));
      const result = await ctx.derive(org, system.id);
      const found = result.items.find((i) => i.itemId === item!.id);
      expect(found?.kind).toBe(derivation.kind);
      expect(result.skipped).toEqual([]);
      return found!.met;
    };

    it('corrective_actions_closed: one closed and verified in the cycle, none open', async () => {
      const { id } = await systemOf(db, 'tst', 'isms');
      const person = (handle: string) => sql`(select id from platform.app_user where handle = ${handle})`;
      await inOrg(db, 'tst', (trx) => sql`update corrective_action set status = 'cancelled' where management_system_id = ${id} and status <> 'cancelled'`.execute(trx));
      expect(await derive('tst', 'isms', { kind: 'corrective_actions_closed' })).toBe(false);
      await inOrg(db, 'tst', (trx) => sql`
        insert into corrective_action (management_system_id, code, title, owner_user_id, status, implemented_at, implemented_by_user_id,
                                       verified_by_user_id, verified_at, effective)
        values (${id}, 'CA-FX-01', 'Fixture action', ${person('rina')}, 'closed', ${TODAY}::date - 5, ${person('bagus')}, ${person('hendra')}, ${TODAY}::date, true)`.execute(trx));
      expect(await derive('tst', 'isms', { kind: 'corrective_actions_closed' })).toBe(true);
      await inOrg(db, 'tst', (trx) => sql`
        insert into corrective_action (management_system_id, code, title, owner_user_id, status) values (${id}, 'CA-FX-02', 'Open action', ${person('rina')}, 'action')`.execute(trx));
      expect(await derive('tst', 'isms', { kind: 'corrective_actions_closed' })).toBe(false);
    });

    it('metrics_current: every metric of the system has a value in its current period', async () => {
      const { id } = await systemOf(db, 'tst', 'isms');
      const linked = sql`select entity_id from entity_ms_link where entity_type = 'metric' and management_system_id = ${id} and deleted_at is null`;
      const [count] = await rowsOf<{ n: number }>(db, 'tst', sql`select count(*)::int as n from metric where id in (${linked}) and deleted_at is null`);
      expect(count!.n).toBeGreaterThan(0);
      await inOrg(db, 'tst', async (trx) => {
        await sql`update metric set last_measured_at = ${TODAY}::date - 1, frequency_code = null where id in (${linked})`.execute(trx);
      });
      expect(await derive('tst', 'isms', { kind: 'metrics_current' })).toBe(true);
      await inOrg(db, 'tst', async (trx) => {
        const one = sql`(select id from metric where id in (${linked}) order by code limit 1)`;
        await sql`update metric set last_measured_at = date '2024-01-01' where id = ${one}`.execute(trx);
        await sql`update metric_value set deleted_at = now() where metric_id = ${one}`.execute(trx);
      });
      expect(await derive('tst', 'isms', { kind: 'metrics_current' })).toBe(false);
    });

    it('documents_reviewed_on_time: approved documents, none expired or past review', async () => {
      const { id } = await systemOf(db, 'tst', 'isms');
      const linked = sql`select entity_id from entity_ms_link where entity_type = 'document' and management_system_id = ${id} and deleted_at is null`;
      await inOrg(db, 'tst', (trx) => sql`update document set status = 'approved', next_review_at = date '2027-06-30' where id in (${linked}) and status in ('approved', 'expired')`.execute(trx));
      expect(await derive('tst', 'isms', { kind: 'documents_reviewed_on_time' })).toBe(true);
      await inOrg(db, 'tst', (trx) => sql`update document set next_review_at = date '2026-09-01' where id = (select id from document where id in (${linked}) and status = 'approved' order by doc_code limit 1)`.execute(trx));
      expect(await derive('tst', 'isms', { kind: 'documents_reviewed_on_time' })).toBe(false);
    });

    it('skips demo organisations, so the demo keeps matching the sample (G.9)', async () => {
      expect(await ctx.derive('ndt')).toEqual({ systems: 0, items: [], skipped: [] });
      // The next tests derive on ndt systems as a customer organisation would.
      await sql`update platform.organization set demo_deploy_label = null where id = ${ORG_IDS.ndt}`.execute(db.migrator);
      ctx.moduleRef.get(TenantResolver).invalidateAll();
    });

    it('bia_approved: every business impact analysis approved and not past review', async () => {
      const { id } = await systemOf(db, 'ndt', 'bcms');
      await inOrg(db, 'ndt', async (trx) => {
        await sql`update business_impact_analysis set status = 'approved', next_review_at = null where management_system_id = ${id}`.execute(trx);
        await sql`insert into business_impact_analysis (management_system_id, code, title, status, analysed_at) values (${id}, 'BIA-FX-01', 'Fixture analysis', 'approved', ${TODAY}::date)`.execute(trx);
      });
      expect(await derive('ndt', 'bcms', { kind: 'bia_approved' })).toBe(true);
      await inOrg(db, 'ndt', (trx) => sql`insert into business_impact_analysis (management_system_id, code, title) values (${id}, 'BIA-FX-02', 'Draft analysis')`.execute(trx));
      expect(await derive('ndt', 'bcms', { kind: 'bia_approved' })).toBe(false);
    });

    it('due_diligence_current: every completed or expired due diligence is current', async () => {
      const { id } = await systemOf(db, 'ndt', 'abms');
      await inOrg(db, 'ndt', async (trx) => {
        await sql`update due_diligence set status = 'superseded' where management_system_id = ${id}`.execute(trx);
        await sql`insert into due_diligence (management_system_id, subject_type, performed_at, valid_until, status)
                  values (${id}, 'business_associate', ${TODAY}::date - 30, ${TODAY}::date + 300, 'completed'),
                         (${id}, 'personnel', ${TODAY}::date - 60, null, 'completed')`.execute(trx);
      });
      expect(await derive('ndt', 'abms', { kind: 'due_diligence_current', months: 12 })).toBe(true);
      await inOrg(db, 'ndt', (trx) => sql`insert into due_diligence (management_system_id, subject_type, performed_at, valid_until, status)
                                          values (${id}, 'business_associate', date '2024-01-10', date '2025-01-09', 'expired')`.execute(trx));
      expect(await derive('ndt', 'abms', { kind: 'due_diligence_current', months: 12 })).toBe(false);
    });
  });
});
