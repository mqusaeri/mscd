// Internal audits (Milestone 2 D.1, D.2, M2-05) on a copy of the demo organisation `tst`: an internal audit planned by
// an Internal Auditor (`internal_audit.manage`) and refused to a Domain Owner, with its scope text and report (a
// document of type record of the system); the Internal Auditor generates and plans the activities of internal audits
// and is refused on any other event type (the interim checks of M2-02 kept); activities name their auditor and the
// clause or control they examine, with the `AUD-INDEP` warning when the auditor owns work of that target; findings
// carry the target code and the register filters by it; the programme coverage of the cycle; `internal_audit_done`
// derived from an internal audit with its report.
import { AuditActivityItem, CertificationCycleItem, CommandResult, FindingItem, InternalAuditProgramme, pageOf, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { covers } from '../../../src/modules/audit-registers/internal-audit.service';
import { useTestDatabase } from '../../setup/test-db';
import { addAuditActivity, addAuditEvent } from '../contract/harness';
import {
  addDocument, auditOf, createCertApp, cyclesOf, inOrg, ORG_IDS, rowsOf, sessionFor, systemOf, verifyChain, type CertApp, type Client,
} from './helpers';

const EVENTS = '/api/v1/ms/isms/audit-events';
const ACTIVITY = (id: string) => `/api/v1/ms/isms/audit-activities/${id}`;
const PROGRAMME = '/api/v1/ms/isms/internal-audit/programme';
const FINDINGS = '/api/v1/ms/isms/findings';
const CYCLES = '/api/v1/ms/isms/certification-cycles';
const internalAudit = { eventType: 'internal_audit', nameEn: 'Internal audit 2026', nameId: 'Audit internal 2026', shortLabel: 'IA 2026', scheduledAt: '2026-11-17', auditDays: 2 };

describe('internal audits (Milestone 2 D.2)', () => {
  const db = useTestDatabase('demo');
  let ctx: CertApp;
  let rina: Client;
  let maya: Client;
  let bagus: Client;
  let eventId: string;
  let activityId: string;
  let ownedTarget: string;
  let freeTarget: string;

  beforeAll(async () => {
    ctx = await createCertApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    // A control whose entry bagus owns, and one where maya owns no entry, document or evidence.
    const [owned] = await rowsOf<{ code: string }>(db, 'tst', sql`
      select ci.item_code as code from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        join management_system m on m.id = e.management_system_id and m.slug = 'isms'
        join platform.app_user u on u.id = e.owner_user_id and u.handle = 'bagus'
       where e.deleted_at is null order by e.position limit 1`);
    ownedTarget = owned!.code;
    const [free] = await rowsOf<{ code: string }>(db, 'tst', sql`
      select ci.item_code as code from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        join management_system m on m.id = e.management_system_id and m.slug = 'isms'
       where e.deleted_at is null and e.is_applicable is not false and e.implementation_status is distinct from 'not_applicable'
         and e.owner_user_id is distinct from (select id from platform.app_user where handle = 'maya')
         and not exists (select 1 from applicability_entry_document ad join document d on d.id = ad.document_id
                          where ad.applicability_entry_id = e.id and d.owner_user_id = (select id from platform.app_user where handle = 'maya'))
         and not exists (select 1 from evidence_target et join evidence ev on ev.id = et.evidence_id
                          where et.applicability_entry_id = e.id and ev.owner_user_id = (select id from platform.app_user where handle = 'maya'))
       order by e.position desc limit 1`);
    freeTarget = free!.code;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('events', () => {
    it('an Internal Auditor plans an internal audit with its scope; a Domain Owner is refused; other types stay with audit_event.manage', async () => {
      const created = await maya.post(EVENTS, { ...internalAudit, scopeText: 'Clauses 4 to 10 and Annex A themes 5 and 8' });
      expect(created.status).toBe(201);
      expect(CommandResult.safeParse(created.body).success).toBe(true);
      eventId = created.body.ref!.id;
      const [row] = await rowsOf<{ event_type: string; scope_text: string; report_document_id: string | null }>(db, 'tst', sql`
        select event_type, scope_text, report_document_id from audit_event where id = ${eventId}`);
      expect(row).toEqual({ event_type: 'internal_audit', scope_text: 'Clauses 4 to 10 and Annex A themes 5 and 8', report_document_id: null });
      expect(await auditOf(db, 'tst', eventId)).toEqual([
        expect.objectContaining({ action: 'audit_event.created', actor: 'maya', after: expect.objectContaining({ event_type: 'internal_audit', scope_text: 'Clauses 4 to 10 and Annex A themes 5 and 8' }) }),
      ]);
      expect((await bagus.post(EVENTS, internalAudit)).status).toBe(403);
      expect((await maya.post(EVENTS, { ...internalAudit, eventType: 'stage1', shortLabel: 'S1' })).status).toBe(403);
      // An MS Manager plans internal audits too.
      expect((await rina.post(EVENTS, { ...internalAudit, shortLabel: 'IA 2027', scheduledAt: '2027-06-08' })).status).toBe(201);
    });

    it('attaches the audit report: a document of type record of the system; another type 422, an unknown one 404', async () => {
      const report = await addDocument(db, 'tst', 'isms', { code: 'IA-REP-2026', type: 'record', owner: 'maya' });
      const policy = await addDocument(db, 'tst', 'isms', { code: 'POL-FX-01', type: 'policy' });
      const wrong = await maya.patch(`${EVENTS}/${eventId}`, { reportDocumentId: policy });
      expect(wrong.status).toBe(422);
      expect(wrong.body).toMatchObject({ messageKey: 'audit.report_not_record', messages: { en: expect.stringMatching(/POL-FX-01 is not a record/), id: expect.any(String) } });
      expect((await maya.patch(`${EVENTS}/${eventId}`, { reportDocumentId: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);

      const attached = await maya.patch(`${EVENTS}/${eventId}`, { reportDocumentId: report, scopeText: 'Clauses 4 to 10, Annex A 5 and 8' });
      expect(attached.status).toBe(200);
      const [row] = await rowsOf<{ report_document_id: string; scope_text: string }>(db, 'tst', sql`select report_document_id, scope_text from audit_event where id = ${eventId}`);
      expect(row).toEqual({ report_document_id: report, scope_text: 'Clauses 4 to 10, Annex A 5 and 8' });
      // internal_audit_done is derived from it (D.4): cycle.derive queued for the system.
      const { id: msId } = await systemOf(db, 'tst', 'isms');
      expect(ctx.queue.waitingJobs('cycle.derive').map((j) => j.env)).toContainEqual(expect.objectContaining({ orgId: ORG_IDS.tst, payload: { msId } }));
      expect((await auditOf(db, 'tst', eventId)).at(-1)).toMatchObject({ action: 'audit_event.updated', actor: 'maya', after: expect.objectContaining({ report_document_id: report }) });
      // The cycles list returns the scope and the report of the event (D.2).
      const listed = (await maya.get<CertificationCycleItem[]>(CYCLES)).body.flatMap((c) => c.events).find((e) => e.id === eventId);
      expect(listed).toMatchObject({ eventType: 'internal_audit', scopeText: 'Clauses 4 to 10, Annex A 5 and 8', reportDocumentId: report });
    });

    it('keeps the event type checks: an Internal Auditor changes no other event and never turns an internal audit into another type', async () => {
      const stage1 = await addAuditEvent(db, 'tst', 'isms', 'stage1');
      expect((await maya.patch(`${EVENTS}/${stage1}`, { expectedFocus: 'Scope' })).status).toBe(403);
      expect((await maya.patch(`${EVENTS}/${eventId}`, { eventType: 'stage2' })).status).toBe(403);
      expect((await maya.patch(`${EVENTS}/${eventId}`, { eventType: 'internal_audit', auditDays: 3 })).status).toBe(200);
      expect((await bagus.patch(`${EVENTS}/${eventId}`, { auditDays: 1 })).status).toBe(403);
    });
  });

  describe('activities', () => {
    it('an Internal Auditor generates and plans the activities of an internal audit and is refused on a stage1 event', async () => {
      const generated = await maya.post(`${EVENTS}/${eventId}/activities/generate`);
      expect(generated.status).toBe(200);
      const stage1 = await addAuditEvent(db, 'tst', 'isms', 'stage1');
      expect((await maya.post(`${EVENTS}/${stage1}/activities/generate`)).status).toBe(403);
      expect((await maya.patch(ACTIVITY(await addAuditActivity(db, 'tst', stage1)), { status: 'done' })).status).toBe(403);
      activityId = await addAuditActivity(db, 'tst', eventId);
      expect((await maya.patch(ACTIVITY(activityId), { auditeeHandle: 'bagus', scheduledAt: '2026-11-17' })).status).toBe(200);
    });

    it('stores the auditor and the target, and warns (AUD-INDEP) when the auditor owns work of the target', async () => {
      const own = await maya.patch(ACTIVITY(activityId), { auditorHandle: 'bagus', targetCode: ownedTarget });
      expect(own.status).toBe(200);
      expect(own.body.warnings).toEqual([
        { rule: 'AUD-INDEP', messages: { en: expect.stringContaining(`owns an entry, document or evidence of ${ownedTarget}`), id: expect.stringMatching(/Auditor sebaiknya/) } },
      ]);
      expect(own.body.warnings![0]!.messages.en).toMatch(/^Bagus/);
      const [row] = await rowsOf<{ auditor: string; target_code: string }>(db, 'tst', sql`
        select u.handle as auditor, a.target_code from audit_activity a join platform.app_user u on u.id = a.auditor_user_id where a.id = ${activityId}`);
      expect(row).toEqual({ auditor: 'bagus', target_code: ownedTarget });

      const independent = await maya.patch(ACTIVITY(activityId), { auditorHandle: 'maya', targetCode: freeTarget });
      expect(independent.status).toBe(200);
      expect(independent.body.warnings).toBeUndefined();
      // A change of another member only (no auditor or target change) gives no warning.
      expect((await maya.patch(ACTIVITY(activityId), { note: 'Sample of ten accounts' })).body.warnings).toBeUndefined();

      const unknown = await maya.patch(ACTIVITY(activityId), { targetCode: 'Z.99.1' });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toMatchObject({ messageKey: 'audit.unknown_target' });
      expect((await maya.patch(ACTIVITY(activityId), { auditorHandle: 'sari' })).body).toMatchObject({ status: 422, rule: 'NOT-A-MEMBER' });

      const list = await bagus.get<AuditActivityItem[]>(`${EVENTS}/${eventId}/activities`);
      expect(list.status).toBe(200);
      expect(AuditActivityItem.array().safeParse(list.body).success).toBe(true);
      expect(list.body.find((a) => a.ref.id === activityId)).toMatchObject({ auditor: 'maya', targetCode: freeTarget, auditee: 'bagus', note: 'Sample of ten accounts' });
      expect((await auditOf(db, 'tst', activityId)).map((a) => a.after)).toContainEqual(expect.objectContaining({ auditor_user_id: 'maya', target_code: freeTarget }));
    });
  });

  describe('programme', () => {
    it('lists clauses 4 to 10 and the applicable controls of the cycle with the internal audits that covered them', async () => {
      const response = await bagus.get<InternalAuditProgramme>(PROGRAMME);
      expect(response.status).toBe(200);
      expect(InternalAuditProgramme.safeParse(response.body).success).toBe(true);
      const [cycle] = await cyclesOf(db, 'tst', 'isms');
      expect(response.body.cycle).toEqual({ id: cycle!.id, cycleStart: cycle!.cycle_start, cycleEnd: cycle!.cycle_end });
      const { editionId, id: msId } = await systemOf(db, 'tst', 'isms');
      const { rows: clauses } = await sql<{ code: string }>`
        select requirement_code as code from ref.requirement where framework_version_id = ${editionId} and not retired order by clause_group::int, sort_order, requirement_code`.execute(db.migrator);
      const [controls] = await rowsOf<{ n: number }>(db, 'tst', sql`
        select count(*)::int as n from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
         where e.management_system_id = ${msId} and e.deleted_at is null and not ci.retired and e.is_applicable is not false
           and e.implementation_status is distinct from 'not_applicable'`);
      const rows = response.body.rows;
      expect(rows.filter((r) => r.kind === 'clause').map((r) => r.code)).toEqual(clauses.map((c) => c.code));
      expect(rows.filter((r) => r.kind === 'control')).toHaveLength(controls!.n);
      expect(rows.filter((r) => r.kind === 'clause').every((r) => r.clauseGroup !== null)).toBe(true);
      // The planned activity covers its target; every row without audits is not covered.
      expect(rows.find((r) => r.code === freeTarget)).toMatchObject({ covered: true, audits: [expect.objectContaining({ eventId, shortLabel: 'IA 2026', scheduledAt: '2026-11-17', activities: 1 })] });
      expect(rows.every((r) => r.covered === r.audits.length > 0)).toBe(true);
      expect(rows.some((r) => !r.covered)).toBe(true);
      // A clause targeted by an activity covers its sub-clauses and its parent.
      expect(covers('9.2', '9.2.1', 'clause')).toBe(true);
      expect(covers('9.2.1', '9.2', 'clause')).toBe(true);
      expect(covers('9.2', '9.3', 'clause')).toBe(false);
      expect(covers('A.5.1', 'A.5.18', 'control')).toBe(false);

      // A clause target of an activity of the same audit (generated template activities may cover the clause already).
      const activitiesOn = (programme: InternalAuditProgramme, code: string) =>
        programme.rows.find((r) => r.code === code)!.audits.find((a) => a.eventId === eventId)?.activities ?? 0;
      const base = activitiesOn(response.body, '9.2');
      const clauseActivity = await addAuditActivity(db, 'tst', eventId);
      expect((await maya.patch(ACTIVITY(clauseActivity), { targetCode: '9.2' })).status).toBe(200);
      const after = (await maya.get<InternalAuditProgramme>(PROGRAMME)).body;
      expect(after.rows.find((r) => r.code === '9.2')).toMatchObject({ covered: true });
      expect(activitiesOn(after, '9.2')).toBe(base + 1);
      // A cancelled activity covers nothing.
      expect((await maya.patch(ACTIVITY(clauseActivity), { status: 'cancelled' })).status).toBe(200);
      expect(activitiesOn((await maya.get<InternalAuditProgramme>(PROGRAMME)).body, '9.2')).toBe(base);

      expect((await bagus.get(`${PROGRAMME}?cycle=${cycle!.id}`)).status).toBe(200);
      expect((await bagus.get(`${PROGRAMME}?cycle=00000000-0000-4000-8000-000000000999`)).status).toBe(404);
      expect((await bagus.get(`${PROGRAMME}?cycle=current`)).status).toBe(400);
    });
  });

  describe('findings', () => {
    it('stores the target code on create and update and filters the register by it', async () => {
      const created = await rina.post(FINDINGS, {
        code: 'IAX-26-01', title: 'Access reviews not evidenced', classification: 'minor', clauseRef: 'A.5.18 access rights', source: 'internal_audit',
        auditEventId: eventId, ownerHandle: 'bagus', targetCode: 'A.5.18',
      });
      expect(created.status).toBe(201);
      const id = created.body.ref!.id;
      expect((await rina.post(FINDINGS, { code: 'IAX-26-02', title: 'x', classification: 'ofi', source: 'internal_audit', ownerHandle: 'bagus', targetCode: 'Z.1' })).body)
        .toMatchObject({ status: 422, messageKey: 'audit.unknown_target' });
      expect((await rina.post(FINDINGS, { code: 'IAX-26-03', title: 'Policy review overdue', classification: 'ofi', source: 'internal_audit', ownerHandle: 'bagus', targetCode: '5.2' })).status).toBe(201);
      // Finding commands queue readiness.recompute and cycle.derive for the system (D.6).
      const { id: msId } = await systemOf(db, 'tst', 'isms');
      expect(ctx.queue.waitingJobs('readiness.recompute').map((j) => j.env.payload)).toContainEqual({ msId });

      const filtered = await maya.get<Page<FindingItem>>(`${FINDINGS}?targetCode=A.5.18`);
      expect(filtered.status).toBe(200);
      expect(pageOf(FindingItem).safeParse(filtered.body).success).toBe(true);
      expect(filtered.body.items.map((f) => [f.code, f.targetCode])).toEqual([['IAX-26-01', 'A.5.18']]);
      expect((await maya.get<Page<FindingItem>>(`${FINDINGS}?targetCode=5.2`)).body.items.map((f) => f.code)).toEqual(['IAX-26-03']);
      expect((await maya.get<Page<FindingItem>>(`${FINDINGS}?targetCode=A.8.8`)).body.items).toEqual([]);

      const [row] = await rowsOf<{ updated_at: Date }>(db, 'tst', sql`select updated_at from finding where id = ${id}`);
      const moved = await rina.patch(`${FINDINGS}/${id}`, { targetCode: 'A.5.15' }, { 'if-match': `W/"${new Date(row!.updated_at).getTime()}"` });
      expect(moved.status).toBe(200);
      expect((await maya.get<Page<FindingItem>>(`${FINDINGS}?targetCode=A.5.15`)).body.items.map((f) => f.code)).toEqual(['IAX-26-01']);
      expect((await auditOf(db, 'tst', id)).at(-1)).toMatchObject({ action: 'finding.updated', before: { target_code: 'A.5.18' }, after: { target_code: 'A.5.15' } });
      expect((await rina.patch(`${FINDINGS}/${id}`, { targetCode: null })).status).toBe(200);
      const all = (await maya.get<Page<FindingItem>>(FINDINGS)).body.items;
      expect(all.find((f) => f.code === 'IAX-26-01')!.targetCode).toBeNull();
    });
  });

  describe('internal_audit_done', () => {
    it('is derived from an internal audit of the cycle with its report', async () => {
      const { id: msId, editionId } = await systemOf(db, 'tst', 'isms');
      await sql`update ref.cycle_requirement_def set derivation = ${JSON.stringify({ kind: 'internal_audit_done' })}::jsonb
                 where framework_version_id = ${editionId} and code = 'INTERNAL_AUDIT'`.execute(db.packInstaller);
      // Only the event counts: no internal audit finding of the cycle, the item not done, and the report detached.
      await inOrg(db, 'tst', async (trx) => {
        await sql`update finding set source = 'other' where management_system_id = ${msId} and source = 'internal_audit'`.execute(trx);
        await sql`update cycle_requirement_status s set status = 'in_progress' from ref.cycle_requirement_def d
                   where d.id = s.cycle_requirement_def_id and d.code = 'INTERNAL_AUDIT' and s.management_system_id = ${msId}`.execute(trx);
        await sql`update audit_event set report_document_id = null where management_system_id = ${msId}`.execute(trx);
      });
      const before = await ctx.derive('tst', msId);
      expect(before.items.find((i) => i.kind === 'internal_audit_done')).toMatchObject({ met: false, changed: false });
      const [report] = await rowsOf<{ id: string }>(db, 'tst', sql`select id from document where doc_code = 'IA-REP-2026'`);
      expect((await maya.patch(`${EVENTS}/${eventId}`, { reportDocumentId: report!.id })).status).toBe(200);
      const after = await ctx.derive('tst', msId);
      expect(after.items.find((i) => i.kind === 'internal_audit_done')).toMatchObject({ met: true, changed: true });
    });
  });

  it('keeps the audit chain intact', async () => {
    expect(await verifyChain(db, 'tst')).toMatchObject({ firstBroken: null });
  });
});
