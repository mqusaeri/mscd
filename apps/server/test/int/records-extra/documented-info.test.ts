// Documented information and pack document code links (Milestone 2 D.1, BR-40, M2-07): the list per
// `ref.documented_info` row with the document that maintains it (by template code, by a link of a pack code, by the
// implementing documents of the clause entry) or the evidence that retains it, with its state and the scope policy;
// `documented-info.link` with its checks and audit; BR-40 accepting the document linked to an activity's output code,
// which the activity then stores and the phase board shows, with BR-47 on that document.
import { CommandResult, DocumentedInfoItem, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { grantRole } from '../commands-implementation/helpers';
import { auditByAction, createExtraApp, etagOf, inOrg, rowsOf, sessionFor, systemOf, type Client, type CommandsApp } from './helpers';

const LIST = '/api/v1/ms/isms/documented-information';
const LINK = (code: string) => `/api/v1/ms/isms/documented-information/${encodeURIComponent(code)}/link`;

describe('documented information and pack code links (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let hendra: Client;
  let nobody: Client;
  let isms: { id: string; version: string };
  let clauses: string[];
  let docs: { id: string; code: string; status: string; owner: string | null }[];

  const list = async (client: Client = rina) => {
    const response = await client.get<DocumentedInfoItem[]>(LIST);
    expect(response.status).toBe(200);
    for (const item of response.body) expect(DocumentedInfoItem.safeParse(item).success).toBe(true);
    return response.body;
  };
  const row = async (code: string, client: Client = rina) => (await list(client)).find((i) => i.code === code)!;

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    nobody = await sessionFor(ctx, db, 'mfa.tester', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
    clauses = (await rowsOf<{ code: string }>(db, 'tst', sql`
      select r.requirement_code as code from ref.requirement r
       where r.framework_version_id = ${isms.version} and not r.retired
         and not exists (select 1 from ref.requirement c where c.parent_id = r.id and not c.retired)
       order by r.sort_order limit 3`)).map((r) => r.code);
    docs = await rowsOf(db, 'tst', sql`
      select d.id, d.doc_code as code, d.status, u.handle as owner from document d
        join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null and l.management_system_id = ${isms.id}
        left join platform.app_user u on u.id = d.owner_user_id
       where d.deleted_at is null and not d.is_org_wide and d.classification <> 'restricted' and u.handle not in ('hendra', 'mfa.tester')
       order by d.doc_code limit 3`);
    // Fixture content of the edition: a template, two maintained rows (one with the template, one without) and one
    // retained row, plus a template that an activity names as its output.
    await inOrg(db, 'tst', async (trx) => {
      await sql`insert into ref.document_template (framework_version_id, code, title, doc_type) values
                  (${isms.version}, 'XTP-01', 'Fixture policy template', 'policy'),
                  (${isms.version}, 'XTP-02', 'Fixture output template', 'procedure')`.execute(trx);
      await sql`insert into ref.documented_info (framework_version_id, code, requirement_code, kind, title, template_code, sort_order) values
                  (${isms.version}, 'XDI-01', ${clauses[0]!}, 'maintain', 'Fixture policy', 'XTP-01', 901),
                  (${isms.version}, 'XDI-02', ${clauses[1]!}, 'maintain', 'Fixture plan', null, 902),
                  (${isms.version}, 'XDI-03', ${clauses[2]!}, 'retain', 'Fixture results', null, 903)`.execute(trx);
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists every documented information row of the edition, missing while nothing covers it', async () => {
    const items = await list(hendra);
    expect(items.filter((i) => i.code.startsWith('XDI-')).map((i) => [i.code, i.kind, i.state, i.document, i.evidence])).toEqual([
      ['XDI-01', 'maintain', 'missing', null, []],
      ['XDI-02', 'maintain', 'missing', null, []],
      ['XDI-03', 'retain', 'missing', null, []],
    ]);
    expect((await row('XDI-01')).templateCode).toBe('XTP-01');
  });

  it('links a pack code to a registered document (audited, readiness queued) and the list shows it with its state', async () => {
    const [docA, docB] = docs;
    const linked = await rina.request('PUT', LINK('XTP-01'), { documentId: docA!.id });
    expect(linked.status).toBe(200);
    expect(CommandResult.safeParse(linked.body).success).toBe(true);
    expect(linked.body).toMatchObject({ ok: true, changed: ['isms'], data: { code: 'XTP-01', documentId: docA!.id } });
    const item = await row('XDI-01');
    expect(item.document).toMatchObject({ id: docA!.id, code: docA!.code, owner: docA!.owner, linked: true });
    expect(['draft', 'in_review', 'approved', 'review_overdue']).toContain(item.state);
    const audit = await auditByAction(db, 'tst', 'document_code.linked');
    expect(audit.at(-1)).toMatchObject({ entity_type: 'document_code_link', entity_code: 'XTP-01', actor: 'rina', before: { document: null }, after: { document: docA!.code } });
    expect(ctx.queue.waitingJobs('readiness.recompute').some((j) => (j.env.payload as { msId?: string }).msId === isms.id)).toBe(true);

    // The same link again changes nothing; another document replaces it; null removes it.
    const again = await rina.request('PUT', LINK('XTP-01'), { documentId: docA!.id });
    expect(again.body.message).toEqual(['Nothing to change', 'Tidak ada yang diubah']);
    expect(await auditByAction(db, 'tst', 'document_code.linked')).toHaveLength(audit.length);
    expect((await rina.request('PUT', LINK('XTP-01'), { documentId: docB!.id })).status).toBe(200);
    expect((await row('XDI-01')).document?.code).toBe(docB!.code);
    expect((await auditByAction(db, 'tst', 'document_code.linked')).at(-1)).toMatchObject({ before: { document: docA!.code }, after: { document: docB!.code } });
    expect((await rina.request('PUT', LINK('XTP-01'), { documentId: null })).status).toBe(200);
    expect((await row('XDI-01')).state).toBe('missing');
    expect((await rina.request('PUT', LINK('XTP-01'), { documentId: docA!.id })).status).toBe(200);
  });

  it('links a row without a template by its own code, and falls back to the implementing documents of its clause entry', async () => {
    const [, docB, docC] = docs;
    // The clause entry of the row's requirement implements a document.
    expect((await rina.post('/api/v1/ms/isms/applicability', { targetType: 'requirement', code: clauses[1]!, isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' })).status).toBe(201);
    const [entry] = await rowsOf<{ id: string; updated_at: Date }>(db, 'tst', sql`
      select e.id, e.updated_at from applicability_entry e join ref.requirement r on r.id = e.requirement_id
       where e.management_system_id = ${isms.id} and r.requirement_code = ${clauses[1]!} and e.deleted_at is null`);
    expect((await rina.patch(`/api/v1/ms/isms/applicability/${entry!.id}`, { documentCodes: [docC!.code] })).status).toBe(200);
    expect((await row('XDI-02')).document).toMatchObject({ code: docC!.code, linked: false });
    // A link of the row's own code wins over the implementing documents.
    expect((await rina.request('PUT', LINK('XDI-02'), { documentId: docB!.id })).status).toBe(200);
    expect((await row('XDI-02')).document).toMatchObject({ code: docB!.code, linked: true });
  });

  it('shows the evidence of a retained row with its freshness', async () => {
    expect((await rina.post('/api/v1/ms/isms/applicability', { targetType: 'requirement', code: clauses[2]!, isApplicable: true, ownerHandle: 'rina', frequencyCode: 'annual' })).status).toBe(201);
    const created = await rina.post('/api/v1/ms/isms/evidence', {
      code: 'EV-XDI3', title: 'Fixture results record', ownerHandle: 'bagus', frequencyCode: 'annual', classification: 'internal',
      targets: [{ targetType: 'requirement', code: clauses[2]! }],
    });
    expect(created.status).toBe(201);
    const item = await row('XDI-03');
    expect(item).toMatchObject({ state: 'out_of_date', document: null, evidence: [{ code: 'EV-XDI3', title: 'Fixture results record', fresh: 'critical' }] });
    // A fresh record keeps the row fresh.
    await inOrg(db, 'tst', (trx) => sql`update evidence set produced_at = date '2026-09-01', external_ref = 'FIXTURE-1' where evidence_code = 'EV-XDI3'`.execute(trx));
    expect((await row('XDI-03')).state).toBe('fresh');
  });

  it('applies the scope policy: Top Management sees no owner or review date of others, an own-scoped role sees only its own records', async () => {
    const top = await row('XDI-01', hendra);
    expect(top.document).toMatchObject({ code: docs[0]!.code, owner: 'none', nextReviewAt: null });
    const own = await row('XDI-01', nobody);
    expect(own.document).toBeNull();
    expect(own.state).toBe((await row('XDI-01')).state);
    expect((await row('XDI-03', nobody)).evidence).toEqual([]);
    expect((await row('XDI-03', bagus)).evidence.map((e) => e.code)).toEqual(['EV-XDI3']);
  });

  it('answers 404 for a code the edition does not use, 422 for a document outside the system, 400 for a bad body and 403 without document.manage', async () => {
    expect((await rina.request('PUT', LINK('NOPE-99'), { documentId: docs[0]!.id })).status).toBe(404);
    const outside = await rina.request('PUT', LINK('XTP-02'), { documentId: '0b7a4e7c-1d2f-4a3b-9c8d-7e6f5a4b3c2d' });
    expect(outside.status).toBe(422);
    expect(outside.body).toMatchObject({ messageKey: 'documented_info.unknown_document' });
    expect((await rina.request('PUT', LINK('XTP-02'), { documentId: 'ISP-001' })).status).toBe(400);
    expect((await bagus.request('PUT', LINK('XTP-02'), { documentId: docs[0]!.id })).status).toBe(403);
    expect((await hendra.request('PUT', LINK('XTP-02'), { documentId: docs[0]!.id })).status).toBe(403);
  });

  it('completes an activity whose output code is linked to a customer document (BR-40) and shows that document on the phase board', async () => {
    const [activity] = await rowsOf<{ id: string; no: string }>(db, 'tst', sql`
      select id, phase_no || '.' || activity_no as no from implementation_activity_progress
       where management_system_id = ${isms.id} and deleted_at is null and status <> 'verified' order by phase_no desc, activity_no limit 1`);
    await inOrg(db, 'tst', (trx) => sql`
      update implementation_activity_progress set status = 'in_progress', output_document_code = 'XTP-02', output_document_id = null,
             blocker_gate_item_ref = null, blocker_reason = null, completed_by_user_id = null, completed_at = null
       where id = ${activity!.id}`.execute(trx));
    const etag = async () => etagOf((await rowsOf<{ updated_at: Date }>(db, 'tst', sql`select updated_at from implementation_activity_progress where id = ${activity!.id}`))[0]!.updated_at);
    const refused = await rina.post(`/api/v1/ms/isms/activities/${activity!.id}/transitions`, { to: 'complete' }, { 'if-match': await etag() });
    expect(refused.status).toBe(422);
    expect(refused.body.rule).toBe('BR-40');

    const docA = docs[0]!;
    expect((await rina.request('PUT', LINK('XTP-02'), { documentId: docA.id })).status).toBe(200);
    const done = await rina.post(`/api/v1/ms/isms/activities/${activity!.id}/transitions`, { to: 'complete' }, { 'if-match': await etag() });
    expect(done.status).toBe(200);
    const snapshot = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    const act = snapshot.bundle.phases.flatMap((p) => p.acts).find((a) => a.no === activity!.no)!;
    expect(act).toMatchObject({ out: 'XTP-02', docId: docA.code, st: 'complete' });
    // The id of the linked document is stored on the activity.
    const stored = async () =>
      (await rowsOf<{ output_document_id: string | null }>(db, 'tst', sql`select output_document_id from implementation_activity_progress where id = ${activity!.id}`))[0]!.output_document_id;
    expect(await stored()).toBe(docA.id);

    // BR-47 runs for a linked document too: verifying the activity while the linked output document is not approved
    // gives the warning.
    const [unapproved] = await rowsOf<{ id: string; code: string }>(db, 'tst', sql`
      select d.id, d.doc_code as code from document d
        join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null and l.management_system_id = ${isms.id}
       where d.deleted_at is null and not d.is_org_wide and d.classification <> 'restricted' and d.status <> 'approved'
       order by d.doc_code limit 1`);
    expect((await rina.request('PUT', LINK('XTP-02'), { documentId: unapproved!.id })).status).toBe(200);
    await inOrg(db, 'tst', (trx) => sql`
      update implementation_activity_progress set status = 'in_progress', output_document_id = null, completed_by_user_id = null, completed_at = null,
             owner_user_id = (select id from platform.app_user where handle = 'rina')
       where id = ${activity!.id}`.execute(trx));
    const again = await rina.post(`/api/v1/ms/isms/activities/${activity!.id}/transitions`, { to: 'complete' }, { 'if-match': await etag() });
    expect(again.status).toBe(200);
    expect(await stored()).toBe(unapproved!.id);
    // A Programme Owner verifies (nobody verifies their own work).
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    const verifier = await sessionFor(ctx, db, 'hendra', 'tst');
    const verified = await verifier.post(`/api/v1/ms/isms/activities/${activity!.id}/transitions`, { to: 'verified' }, { 'if-match': await etag() });
    expect(verified.status).toBe(200);
    expect(verified.body.warnings?.map((w) => w.rule)).toContain('BR-47');
  });
});
