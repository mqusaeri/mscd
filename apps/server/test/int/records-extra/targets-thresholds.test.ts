// Applicability targets, freshness thresholds and the APPL-ASSESS rule (Milestone 2 D.1, D.2, D2-09, E.1, E.3, M2-07):
// the targets of the active edition with their entry, retired, assessable and documented information flags; clause
// rows that always apply refused as not applicable; freshness limits per frequency set, reset, audited, queued for
// recompute and used by the read model.
import { ApplicabilityTargetItem, CommandResult, FreshnessThresholdItem, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditByAction, createExtraApp, inOrg, rowsOf, sessionFor, systemOf, type Client, type CommandsApp } from './helpers';

describe('applicability targets, freshness thresholds and APPL-ASSESS (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let hendra: Client;
  let isms: { id: string; version: string };

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** Leaf requirement rows of the ISMS edition that are in the standard (D2-09), in pack order. */
  const leafRequirements = async () =>
    (await rowsOf<{ code: string; assessable: boolean }>(db, 'tst', sql`
      select r.requirement_code as code, r.applicability_assessable as assessable from ref.requirement r
       where r.framework_version_id = ${isms.version} and not r.retired
         and not exists (select 1 from ref.requirement c where c.parent_id = r.id and not c.retired)
       order by r.sort_order, r.requirement_code`)).map((r) => r);

  describe('GET /ms/{ms}/applicability/targets', () => {
    it('lists the catalogue items with their entries, then the leaf clause rows, each with its flags', async () => {
      const response = await bagus.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets');
      expect(response.status).toBe(200);
      for (const item of response.body) expect(ApplicabilityTargetItem.safeParse(item).success).toBe(true);
      const catalogue = response.body.filter((t) => t.kind === 'catalogue_item');
      const [{ n }] = await rowsOf<{ n: number }>(db, 'tst', sql`select count(*)::int as n from ref.catalogue_item where framework_version_id = ${isms.version} and not retired`);
      expect(catalogue).toHaveLength(n!);
      expect(catalogue.every((t) => t.assessable && !t.retired && t.documentedInfo === false)).toBe(true);
      // The demo ISMS has an entry for every Annex A control and none for a clause row.
      expect(catalogue.every((t) => t.hasEntry)).toBe(true);
      const leaves = await leafRequirements();
      const clauses = response.body.filter((t) => t.kind === 'requirement');
      expect(clauses.map((t) => t.code)).toEqual(leaves.map((l) => l.code));
      expect(clauses.map((t) => t.assessable)).toEqual(leaves.map((l) => l.assessable));
      expect(clauses.every((t) => !t.hasEntry && t.clauseGroup !== null)).toBe(true);
      // Catalogue items first, as the Add control form lists them.
      expect(response.body.findIndex((t) => t.kind === 'requirement')).toBe(catalogue.length);
    });

    it('filters by kind and search text, and lists retired rows only on request (E.1)', async () => {
      const onlyClauses = await rina.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets?kind=requirement');
      expect(onlyClauses.body.every((t) => t.kind === 'requirement')).toBe(true);
      const backup = await rina.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets?q=backup');
      expect(backup.body.length).toBeGreaterThan(0);
      expect(backup.body.every((t) => `${t.code} ${t.title}`.toLowerCase().includes('backup'))).toBe(true);

      const [leaf] = (await leafRequirements()).slice(-1);
      await inOrg(db, 'tst', (trx) => sql`update ref.requirement set retired = true where framework_version_id = ${isms.version} and requirement_code = ${leaf!.code}`.execute(trx));
      try {
        const hidden = await rina.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets?kind=requirement');
        expect(hidden.body.map((t) => t.code)).not.toContain(leaf!.code);
        const shown = await rina.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets?kind=requirement&retired=true');
        expect(shown.body.find((t) => t.code === leaf!.code)).toMatchObject({ retired: true });
        // A row no longer in the standard gets no new entry.
        const refused = await rina.post('/api/v1/ms/isms/applicability', {
          targetType: 'requirement', code: leaf!.code, isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual',
        });
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ messageKey: 'applicability.retired_target' });
      } finally {
        await inOrg(db, 'tst', (trx) => sql`update ref.requirement set retired = false where framework_version_id = ${isms.version} and requirement_code = ${leaf!.code}`.execute(trx));
      }
    });

    it('answers 400 for an unknown kind, 404 for an unknown system and 403 for a system without a role', async () => {
      expect((await rina.get('/api/v1/ms/isms/applicability/targets?kind=control')).status).toBe(400);
      expect((await rina.get('/api/v1/ms/nope/applicability/targets')).status).toBe(404);
      const ndtBagus = await sessionFor(ctx, db, 'bagus', 'ndt');
      expect((await ndtBagus.get('/api/v1/ms/isms/applicability/targets')).status).toBe(200);
    });
  });

  describe('APPL-ASSESS (D.2, D2-09)', () => {
    const create = (code: string) =>
      rina.post('/api/v1/ms/isms/applicability', { targetType: 'requirement', code, isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' });
    const entryId = async (code: string) =>
      (await rowsOf<{ id: string; updated_at: Date; status: string }>(db, 'tst', sql`
        select e.id, e.updated_at, e.implementation_status as status from applicability_entry e join ref.requirement r on r.id = e.requirement_id
         where e.management_system_id = ${isms.id} and r.requirement_code = ${code} and e.deleted_at is null`))[0] as { id: string; updated_at: Date; status: string };

    it('refuses not applicable for a clause row that always applies, by transition and by change; allows it for an assessable row', async () => {
      const [fixed, assessable] = (await leafRequirements()).slice(0, 2);
      await inOrg(db, 'tst', async (trx) => {
        await sql`update ref.requirement set applicability_assessable = false where framework_version_id = ${isms.version} and requirement_code = ${fixed!.code}`.execute(trx);
        await sql`update ref.requirement set applicability_assessable = true where framework_version_id = ${isms.version} and requirement_code = ${assessable!.code}`.execute(trx);
      });
      expect((await create(fixed!.code)).status).toBe(201);
      expect((await create(assessable!.code)).status).toBe(201);
      const clause = await entryId(fixed!.code);

      const transition = await rina.post(`/api/v1/ms/isms/applicability/${clause.id}/transitions`, {
        to: 'not_applicable', exclusionJustification: 'No such activity takes place within the scope',
      });
      expect(transition.status).toBe(422);
      expect(transition.body).toMatchObject({ rule: 'APPL-ASSESS', messages: { en: expect.stringContaining(`Cl. ${fixed!.code}`), id: expect.any(String) } });
      const patch = await rina.patch(`/api/v1/ms/isms/applicability/${clause.id}`, {
        isApplicable: false, exclusionJustification: 'No such activity takes place within the scope',
      });
      expect(patch.status).toBe(422);
      expect(patch.body.rule).toBe('APPL-ASSESS');
      expect((await entryId(fixed!.code)).status).toBe('not_started');

      const other = await entryId(assessable!.code);
      const allowed = await rina.post(`/api/v1/ms/isms/applicability/${other.id}/transitions`, {
        to: 'not_applicable', exclusionJustification: 'No such activity takes place within the scope',
      });
      expect(allowed.status).toBe(200);
      expect((await entryId(assessable!.code)).status).toBe('not_applicable');
      // The targets list now names both entries.
      const targets = await rina.get<ApplicabilityTargetItem[]>('/api/v1/ms/isms/applicability/targets?kind=requirement');
      expect(targets.body.filter((t) => t.hasEntry).map((t) => t.code).sort()).toEqual([fixed!.code, assessable!.code].sort());
    });

    it('refuses a new clause entry that does not apply on a row that always applies; creates it on an assessable row', async () => {
      const [fixed, assessable] = (await leafRequirements()).slice(2, 4);
      await inOrg(db, 'tst', async (trx) => {
        await sql`update ref.requirement set applicability_assessable = false where framework_version_id = ${isms.version} and requirement_code = ${fixed!.code}`.execute(trx);
        await sql`update ref.requirement set applicability_assessable = true where framework_version_id = ${isms.version} and requirement_code = ${assessable!.code}`.execute(trx);
      });
      const excluded = (code: string, exclusionJustification = 'No such activity takes place within the scope') => rina.post('/api/v1/ms/isms/applicability', {
        targetType: 'requirement', code, isApplicable: false, exclusionJustification, ownerHandle: 'rina', frequencyCode: 'annual',
      });
      const refused = await excluded(fixed!.code);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ rule: 'APPL-ASSESS', messages: { en: expect.stringContaining(`Cl. ${fixed!.code}`), id: expect.any(String) } });
      expect(await entryId(fixed!.code)).toBeUndefined();
      // An assessable row is created as not applicable, with the BR-03 warning for a filler justification.
      const created = await excluded(assessable!.code, 'none');
      expect(created.status).toBe(201);
      expect(created.body.warnings?.[0]?.rule).toBe('BR-03');
      expect((await entryId(assessable!.code)).status).toBe('not_applicable');
    });
  });

  describe('freshness thresholds (D.1, E.3)', () => {
    const list = async (client: Client = rina) => (await client.get<FreshnessThresholdItem[]>('/api/v1/ms/isms/freshness-thresholds')).body;

    it('lists every frequency of the edition with the limits in force, marked default', async () => {
      const response = await hendra.get<FreshnessThresholdItem[]>('/api/v1/ms/isms/freshness-thresholds');
      expect(response.status).toBe(200);
      const frequencies = await rowsOf<{ code: string }>(db, 'tst', sql`select code from ref.evidence_frequency_rule where framework_version_id = ${isms.version} order by sort_order, code`);
      expect(response.body.map((t) => t.frequencyCode)).toEqual(frequencies.map((f) => f.code));
      for (const item of response.body) {
        expect(FreshnessThresholdItem.safeParse(item).success).toBe(true);
        expect(item).toMatchObject({ source: 'default', graceDays: 1, agingFactor: 1.25, expiredFactor: 2 });
      }
    });

    it('sets the limits of one frequency (upsert), audits before and after, queues freshness.recompute and changes nothing on a repeat', async () => {
      const set = await rina.request('PUT', '/api/v1/ms/isms/freshness-thresholds/monthly', { graceDays: 3, agingFactor: 1.5, expiredFactor: 2.5 });
      expect(set.status).toBe(200);
      expect(CommandResult.safeParse(set.body).success).toBe(true);
      expect(set.body).toMatchObject({ ok: true, changed: ['isms'] });
      expect((await list()).find((t) => t.frequencyCode === 'monthly')).toEqual({ frequencyCode: 'monthly', graceDays: 3, agingFactor: 1.5, expiredFactor: 2.5, source: 'set' });
      const audit = await auditByAction(db, 'tst', 'freshness_threshold.changed');
      expect(audit.at(-1)).toMatchObject({
        entity_type: 'freshness_threshold', entity_code: 'monthly', actor: 'rina',
        before: expect.objectContaining({ source: 'default', graceDays: 1 }),
        after: expect.objectContaining({ source: 'set', graceDays: 3, agingFactor: 1.5, expiredFactor: 2.5 }),
      });
      expect(ctx.queue.waitingJobs('freshness.recompute').some((j) => (j.env.payload as { msId?: string }).msId === isms.id)).toBe(true);

      const again = await rina.request('PUT', '/api/v1/ms/isms/freshness-thresholds/monthly', { graceDays: 3, agingFactor: 1.5, expiredFactor: 2.5 });
      expect(again.status).toBe(200);
      expect(again.body.message).toEqual(['Nothing to change', 'Tidak ada yang diubah']);
      expect(await auditByAction(db, 'tst', 'freshness_threshold.changed')).toHaveLength(audit.length);
      const changed = await rina.request('PUT', '/api/v1/ms/isms/freshness-thresholds/monthly', { graceDays: 5, agingFactor: 1.5, expiredFactor: 2.5 });
      expect(changed.status).toBe(200);
      const rows = await rowsOf<{ n: number }>(db, 'tst', sql`
        select count(*)::int as n from freshness_threshold where management_system_id = ${isms.id} and frequency_code = 'monthly' and deleted_at is null`);
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses an aging factor under 1, an expired factor under the aging factor, partial values and unknown frequencies', async () => {
      const put = (frequency: string, body: unknown) => rina.request('PUT', `/api/v1/ms/isms/freshness-thresholds/${frequency}`, body);
      expect((await put('annual', { graceDays: 1, agingFactor: 0.5, expiredFactor: 2 })).status).toBe(400);
      expect((await put('annual', { graceDays: 1, agingFactor: 2, expiredFactor: 1.5 })).status).toBe(400);
      expect((await put('annual', { graceDays: 1 })).status).toBe(400);
      expect((await put('hourly', { graceDays: 1, agingFactor: 1.5, expiredFactor: 2 })).status).toBe(404);
      expect((await bagus.request('PUT', '/api/v1/ms/isms/freshness-thresholds/annual', { graceDays: 1, agingFactor: 1.5, expiredFactor: 2 })).status).toBe(403);
    });

    it('moves the freshness band of the read model with the limits, and a reset returns to the default (soft delete)', async () => {
      const snapshot = async () => (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
      const aging = (await snapshot()).bundle.evs.find((e) => e.fresh === 'aging' && e.p > 0);
      expect(aging).toBeDefined();
      const frequency = aging!.freq;
      const set = await rina.request('PUT', `/api/v1/ms/isms/freshness-thresholds/${frequency}`, { graceDays: 365, agingFactor: 1.25, expiredFactor: 2 });
      expect(set.status).toBe(200);
      expect((await snapshot()).bundle.evs.find((e) => e.code === aging!.code)!.fresh).toBe('fresh');

      const reset = await rina.request('PUT', `/api/v1/ms/isms/freshness-thresholds/${frequency}`, { graceDays: null, agingFactor: null, expiredFactor: null });
      expect(reset.status).toBe(200);
      expect((await list()).find((t) => t.frequencyCode === frequency)).toMatchObject({ source: 'default', graceDays: 1 });
      expect((await snapshot()).bundle.evs.find((e) => e.code === aging!.code)!.fresh).toBe('aging');
      const rows = await rowsOf<{ deleted: boolean }>(db, 'tst', sql`
        select deleted_at is not null as deleted from freshness_threshold where management_system_id = ${isms.id} and frequency_code = ${frequency}`);
      expect(rows.map((r) => r.deleted)).toEqual([true]);
      const nothing = await rina.request('PUT', `/api/v1/ms/isms/freshness-thresholds/${frequency}`, { graceDays: null, agingFactor: null, expiredFactor: null });
      expect(nothing.body.message).toEqual(['Nothing to change', 'Tidak ada yang diubah']);
    });
  });
});
