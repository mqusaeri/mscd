// Management reviews and cycle derivation (build plan D.3 "Registers and workflows: audit side", C.13
// `management_review.status`, BR-13, BR-14, E.2 `cycle.derive`, WP-37). Since the content step of the packs
// (Milestone 2 E.2, M2-04) the editions define mandatory review inputs (ten in ISO/IEC 27001, twelve in ISO 9001) and
// derivations on their cycle requirements. This file proves that `cycle.derive` leaves the demo organisations alone
// (Milestone 2 D.4: they keep the sample statuses) and derives the test organisation `tst` from the pack derivations;
// that a joint review of the `ndt` ISMS and QMS gets one input row per mandatory input of each system, cannot close
// while a QMS input is empty (BR-13) or without decisions (BR-14), and queues `cycle.derive` for both systems when it
// closes; and that on `tst` the derivation sets `MGMT_REVIEW` done only after a review closed with every mandatory
// input. Fixture rows cover only what the packs do not hold: an optional input, a mandatory input added after a
// closure, and a derivation kind the server does not know.
import { ManagementReviewItem } from '@mscd/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  addReviewInputs, auditOf, createAuditApp, cycleItemsOf, inOrg, ORG_IDS, REVIEWS, rowsOf, sessionFor, setDerivation, systemOf, TODAY, verifyChain,
  type AuditApp, type Client,
} from './helpers';

/** The review input codes of a pack edition: `MR-01` to `MR-<count>`. */
const inputCodes = (count: number) => Array.from({ length: count }, (_, i) => `MR-${String(i + 1).padStart(2, '0')}`);
/** The ten review inputs of the ISO/IEC 27001 pack (clause 9.3.2), all mandatory. */
const ISMS_INPUTS = inputCodes(10);
/** The twelve review inputs of the ISO 9001:2015 pack (clause 9.3.2), all mandatory. */
const QMS_INPUTS = inputCodes(12);

/** The cycle requirements of the ISO/IEC 27001 pack with the derivation kind of each, in position order. */
const ISMS_DERIVATIONS = [
  ['RISK_ASSESSMENT', 'risk_assessment_current'],
  ['INTERNAL_AUDIT', 'internal_audit_done'],
  ['MGMT_REVIEW', 'management_review_closed'],
  ['CORRECTIVE_ACTION', 'corrective_actions_closed'],
  ['PERFORMANCE_EVALUATION', 'metrics_current'],
  ['DOCUMENT_REVIEW', 'documents_reviewed_on_time'],
];

describe('management reviews and cycle derivation', () => {
  const db = useTestDatabase('demo');
  let ctx: AuditApp;

  beforeAll(async () => {
    ctx = await createAuditApp(db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps the cycle statuses of the demo organisations and derives tst from the pack derivations', async () => {
    const statuses = (org: 'ndt' | 'bsd' | 'rmn') =>
      rowsOf<{ id: string; status: string; updated_at: Date }>(db, org, sql`select id, status, updated_at from cycle_requirement_status order by id`);
    for (const org of ['ndt', 'bsd', 'rmn'] as const) {
      const before = await statuses(org);
      expect(before.length).toBeGreaterThan(0);
      expect(await ctx.derive(org)).toEqual({ systems: 0, items: [], skipped: [] });
      expect(await statuses(org)).toEqual(before);
    }

    // tst has no demo label, so every cycle requirement of its ISMS with a pack derivation is decided by its data.
    const before = await cycleItemsOf(db, 'tst', 'isms');
    const codeOf = new Map(before.map((i) => [i.id, i.def_code]));
    const result = await ctx.derive('tst');
    expect(result.systems).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.items.map((i) => [codeOf.get(i.itemId), i.kind])).toEqual(ISMS_DERIVATIONS);
    // The seeded data of tst meets the internal audit requirement only (findings of its internal audit raised in the
    // cycle); no management review has closed, and its risks, corrective actions, metrics and documents fall short.
    expect(Object.fromEntries(result.items.map((i) => [codeOf.get(i.itemId), i.met]))).toEqual({
      RISK_ASSESSMENT: false, INTERNAL_AUDIT: true, MGMT_REVIEW: false, CORRECTIVE_ACTION: false, PERFORMANCE_EVALUATION: false, DOCUMENT_REVIEW: false,
    });
    const after = await cycleItemsOf(db, 'tst', 'isms');
    for (const item of result.items) {
      const was = before.find((b) => b.id === item.itemId)!;
      expect(item.changed, was.def_code!).toBe(item.met && was.status !== 'done');
      expect(after.find((a) => a.id === item.itemId)!.status, was.def_code!).toBe(item.met ? 'done' : was.status);
    }
    expect(after.find((a) => a.def_code === 'INTERNAL_AUDIT')!.status).toBe('done');
    // Idempotent: a second run changes nothing.
    expect((await ctx.derive('tst')).items.filter((i) => i.changed)).toEqual([]);
  });

  describe('joint review of the ndt ISMS and QMS', () => {
    let rina: Client;
    let sari: Client;
    let bagus: Client;
    let hendra: Client;
    let reviewId: string;

    beforeAll(async () => {
      rina = await sessionFor(ctx, db, 'rina', 'ndt');
      sari = await sessionFor(ctx, db, 'sari', 'ndt');
      bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
      hendra = await sessionFor(ctx, db, 'hendra', 'ndt');
      // Every pack input is mandatory; an optional input is a fixture row.
      const isms = await systemOf(db, 'ndt', 'isms');
      await addReviewInputs(db, isms.editionId, [{ code: 'MRX-01', title: 'Benchmark with peer organisations', mandatory: false }]);
    });

    it('plans a joint review with one input row per mandatory input and linked system', async () => {
      const body = { code: 'MR-2026-J', title: 'Joint management review 2026', plannedAt: '2026-10-28', ownerHandle: 'hendra', linkedMs: ['isms', 'qms'] };
      expect((await bagus.post(REVIEWS('isms'), body)).status).toBe(403);
      expect((await rina.post(REVIEWS('isms'), { ...body, linkedMs: ['qms'] })).status).toBe(422);
      expect((await rina.post(REVIEWS('isms'), { ...body, linkedMs: ['isms', 'nope'] })).status).toBe(404);
      const created = await rina.post(REVIEWS('isms'), body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ changed: ['isms', 'qms'], count: ISMS_INPUTS.length + QMS_INPUTS.length, ref: { entityType: 'management_review', code: 'MR-2026-J' } });
      reviewId = created.body.ref!.id;
      expect((await rina.post(REVIEWS('isms'), body)).status).toBe(409);

      const list = await hendra.get<ManagementReviewItem[]>(REVIEWS('qms'));
      expect(z.array(ManagementReviewItem).safeParse(list.body).success).toBe(true);
      const review = list.body.find((r) => r.code === 'MR-2026-J')!;
      expect(review).toMatchObject({ status: 'planned', owner: 'hendra', linkedMs: ['isms', 'qms'], decisionsRecorded: false });
      expect(review.inputs.map((i) => [i.ms, i.defCode, i.mandatory, i.complete])).toEqual([
        ...ISMS_INPUTS.map((code) => ['isms', code, true, false]),
        ...QMS_INPUTS.map((code) => ['qms', code, true, false]),
      ]);
      // Each system's inputs are those of its own pack.
      expect(review.inputs.find((i) => i.ms === 'isms' && i.defCode === 'MR-09')).toMatchObject({ title: 'Results of risk assessment and status of the risk treatment plan' });
      expect(review.inputs.find((i) => i.ms === 'qms' && i.defCode === 'MR-03')).toMatchObject({ title: 'Customer satisfaction and feedback from interested parties' });
      expect((await auditOf(db, 'ndt', reviewId))[0]).toMatchObject({ action: 'management_review.created', actor: 'rina' });
    });

    it('cannot close while a QMS mandatory input is empty (BR-13) or without decisions (BR-14)', async () => {
      const url = `${REVIEWS('isms')}/${reviewId}`;
      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved' })).status).toBe(409);
      for (const code of ISMS_INPUTS) expect((await rina.request('PUT', `${url}/inputs/${code}`, { content: `ISMS input ${code} reviewed` })).status, code).toBe(200);
      expect((await rina.request('PUT', `${url}/inputs/MRX-01`, { content: 'Automate the access reviews' })).status).toBe(200);
      // MR-11 is an input of the QMS edition only, so the ISMS path does not reach it.
      expect((await rina.request('PUT', `${url}/inputs/MR-11`, { content: 'x' })).status).toBe(404);
      expect((await bagus.request('PUT', `${url}/inputs/MR-01`, { content: 'x' })).status).toBe(403);
      // The QMS MS Manager does not manage ISMS reviews, so cannot move the joint review through the QMS path.
      expect((await sari.post(`${REVIEWS('qms')}/${reviewId}/transitions`, { to: 'held', heldAt: '2026-09-28' })).status).toBe(403);
      const held = await rina.post(`${url}/transitions`, { to: 'held', heldAt: '2026-09-28' });
      expect(held.status).toBe(200);

      const missing = await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved for PAM' });
      expect(missing.body).toMatchObject({ status: 422, rule: 'BR-13', affected: ['qms'] });
      // The QMS inputs are recorded through the QMS path by its MS Manager; one empty input still blocks the closure.
      for (const code of QMS_INPUTS.slice(0, -1)) {
        expect((await sari.request('PUT', `${REVIEWS('qms')}/${reviewId}/inputs/${code}`, { content: `QMS input ${code} reviewed` })).status, code).toBe(200);
      }
      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved for PAM' })).body).toMatchObject({ status: 422, rule: 'BR-13', affected: ['qms'] });
      expect((await sari.request('PUT', `${REVIEWS('qms')}/${reviewId}/inputs/MR-12`, { content: 'Two improvement projects for 2027' })).status).toBe(200);
      expect((await rina.post(`${url}/transitions`, { to: 'closed' })).body).toMatchObject({ status: 422, rule: 'BR-14' });
      expect(ctx.queue.waitingJobs('cycle.derive')).toEqual([]);

      const closed = await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Budget approved for PAM' });
      expect(closed.status).toBe(200);
      expect(closed.body.changed).toEqual(['isms', 'qms']);
      const [row] = await rowsOf<Record<string, unknown>>(db, 'ndt', sql`select * from management_review where id = ${reviewId}`);
      expect(row).toMatchObject({ status: 'closed', held_at: '2026-09-28', closed_at: TODAY, decisions_recorded: true, decisions_text: 'Budget approved for PAM' });
      // Closing queued cycle.derive for both linked systems.
      const isms = await systemOf(db, 'ndt', 'isms');
      const qms = await systemOf(db, 'ndt', 'qms');
      expect(ctx.queue.waitingJobs('cycle.derive').map((j) => j.env)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ orgId: ORG_IDS.ndt, payload: { msId: isms.id } }),
          expect.objectContaining({ orgId: ORG_IDS.ndt, payload: { msId: qms.id } }),
        ]),
      );
      const review = (await hendra.get<ManagementReviewItem[]>(REVIEWS('isms'))).body.find((r) => r.code === 'MR-2026-J')!;
      expect(review.inputs).toHaveLength(ISMS_INPUTS.length + 1 + QMS_INPUTS.length);
      expect(review.inputs.every((i) => i.complete)).toBe(true);
      expect(review.inputs.find((i) => i.defCode === 'MRX-01')).toMatchObject({ ms: 'isms', mandatory: false, content: 'Automate the access reviews' });
      // A closed review's inputs no longer change.
      expect((await rina.request('PUT', `${url}/inputs/MR-01`, { content: 'Changed' })).status).toBe(409);
      expect((await auditOf(db, 'ndt', reviewId)).map((a) => a.action)).toEqual([
        'management_review.created',
        ...Array<string>(ISMS_INPUTS.length + 1).fill('management_review.input_updated'),
        'management_review.transition',
        ...Array<string>(QMS_INPUTS.length).fill('management_review.input_updated'),
        'management_review.transition',
      ]);
      expect(await verifyChain(db, 'ndt')).toMatchObject({ firstBroken: null });
    });
  });

  describe('cycle.derive on the tst ISMS with the pack derivations', () => {
    let rina: Client;
    let editionId: string;
    let msId: string;

    beforeAll(async () => {
      rina = await sessionFor(ctx, db, 'rina', 'tst');
      ({ id: msId, editionId } = await systemOf(db, 'tst', 'isms'));
      // The seeded item starts as not done, so the derivation has something to decide.
      await inOrg(db, 'tst', (trx) =>
        sql`update cycle_requirement_status s set status = 'in_progress' from ref.cycle_requirement_def d
             where d.id = s.cycle_requirement_def_id and d.code = 'MGMT_REVIEW'`.execute(trx),
      );
    });

    const mgmt = async () => (await cycleItemsOf(db, 'tst', 'isms')).find((i) => i.def_code === 'MGMT_REVIEW')!;
    const mgmtRun = async () => (await ctx.derive('tst', msId)).items.find((i) => i.kind === 'management_review_closed');

    it('sets MGMT_REVIEW done only after a review closed with every mandatory input', async () => {
      const item = await mgmt();
      expect(item.status).toBe('in_progress');
      expect(item.cycle_start <= TODAY && TODAY <= item.cycle_end).toBe(true);

      // No review: nothing changes.
      expect(await mgmtRun()).toMatchObject({ itemId: item.id, met: false, changed: false });
      const created = await rina.post(REVIEWS('isms'), { code: 'MR-2026-T', title: 'Management review 2026', plannedAt: TODAY, ownerHandle: 'rina', linkedMs: ['isms'] });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ count: ISMS_INPUTS.length });
      const url = `${REVIEWS('isms')}/${created.body.ref!.id}`;
      expect((await rina.post(`${url}/transitions`, { to: 'held' })).status).toBe(200);
      for (const code of ISMS_INPUTS.slice(0, -1)) expect((await rina.request('PUT', `${url}/inputs/${code}`, { content: `Input ${code} reviewed` })).status, code).toBe(200);
      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Keep the plan' })).body).toMatchObject({ status: 422, rule: 'BR-13' });
      expect((await rina.request('PUT', `${url}/inputs/MR-10`, { content: 'Improvement opportunities reviewed' })).status).toBe(200);
      // Held with complete inputs but not closed: still not done.
      expect(await mgmtRun()).toMatchObject({ met: false, changed: false });
      expect((await mgmt()).status).toBe('in_progress');

      expect((await rina.post(`${url}/transitions`, { to: 'closed', decisionsText: 'Keep the plan' })).status).toBe(200);
      // A mandatory input added to the edition after the closure (a fixture row) leaves the review incomplete: not done.
      await addReviewInputs(db, editionId, [{ code: 'MRX-02', title: 'Results of supplier audits', mandatory: true }]);
      expect(await mgmtRun()).toMatchObject({ met: false, changed: false });
      expect((await mgmt()).status).toBe('in_progress');
      // The fixture input becomes optional again (the pack installer role updates framework content, it never deletes it).
      await sql`update ref.review_input_def set mandatory = false where framework_version_id = ${editionId} and code = 'MRX-02'`.execute(db.packInstaller);

      // Closed with every mandatory input complete: done, by the system.
      expect(await mgmtRun()).toMatchObject({ met: true, changed: true });
      const done = await mgmt();
      expect(done.status).toBe('done');
      expect(await auditOf(db, 'tst', done.id)).toEqual([
        expect.objectContaining({ action: 'cycle_item.updated', actor: 'system', before: { status: 'in_progress' }, after: { status: 'done', derivation: 'management_review_closed' } }),
      ]);
      // Idempotent: a second run changes nothing.
      expect(await mgmtRun()).toMatchObject({ met: true, changed: false });
      expect(await auditOf(db, 'tst', done.id)).toHaveLength(1);
    });

    it('derives the other kinds from the data and skips unknown kinds', async () => {
      // A derivation kind the server does not know is a fixture on one requirement; the pack's own is put back below.
      const [pack] = (
        await sql<{ derivation: Record<string, unknown> }>`select derivation from ref.cycle_requirement_def
          where framework_version_id = ${editionId} and code = 'CORRECTIVE_ACTION'`.execute(db.packInstaller)
      ).rows;
      expect(pack!.derivation).toEqual({ kind: 'corrective_actions_closed' });
      await setDerivation(db, editionId, 'CORRECTIVE_ACTION', { kind: 'corrective_action_magic' });
      const before = await cycleItemsOf(db, 'tst', 'isms');
      const [expected] = await rowsOf<{ internal: boolean; risks_current: boolean }>(
        db,
        'tst',
        sql`select exists (select 1 from finding f join certification_cycle c on c.id = (select certification_cycle_id from cycle_requirement_status where id = ${before[0]!.id})
                            where f.management_system_id = ${msId} and f.deleted_at is null and f.source = 'internal_audit'
                              and f.raised_at between c.cycle_start and c.cycle_end) as internal,
                   (select count(*) > 0 and bool_and(r.assessed_at >= (${TODAY}::date - interval '12 months')::date)
                      from risk r join entity_ms_link l on l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${msId} and l.deleted_at is null
                     where r.deleted_at is null) as risks_current`,
      );
      const result = await ctx.derive('tst', msId);
      const byCode = new Map(before.map((i) => [i.id, i.def_code]));
      const kinds = Object.fromEntries(result.items.map((i) => [byCode.get(i.itemId), i.met]));
      expect(Object.keys(kinds)).toEqual(['RISK_ASSESSMENT', 'INTERNAL_AUDIT', 'MGMT_REVIEW', 'PERFORMANCE_EVALUATION', 'DOCUMENT_REVIEW']);
      expect(kinds).toMatchObject({ MGMT_REVIEW: true, INTERNAL_AUDIT: expected!.internal, RISK_ASSESSMENT: expected!.risks_current === true });
      expect(result.skipped).toEqual([expect.objectContaining({ kind: 'corrective_action_magic' })]);
      const after = await cycleItemsOf(db, 'tst', 'isms');
      for (const item of after) {
        const was = before.find((b) => b.id === item.id)!;
        expect(item.status, item.def_code!).toBe(kinds[item.def_code!] === true ? 'done' : was.status);
      }
      await setDerivation(db, editionId, 'CORRECTIVE_ACTION', pack!.derivation);
      expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
    });
  });
});
