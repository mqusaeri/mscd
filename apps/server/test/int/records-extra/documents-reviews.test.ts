// External documents, the version history and management review changes (Milestone 2 D.1, D.2, M2-07): origin,
// source, reference and date received on create and change, `origin` in the snapshot only for external documents;
// versions newest first with the change summary and the scope policy of the document; a planned or held management
// review changed with If-Match, its linked systems moved with their inputs, a closed review refused.
import { DocumentVersionItem, type UiMsSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditOf, createExtraApp, idOf, inOrg, rowsOf, sessionFor, systemOf, type Client, type CommandsApp } from './helpers';

describe('external documents, versions and management review changes (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let hendra: Client;
  let isms: { id: string; version: string };
  let docType: string;

  const docRow = async (code: string) =>
    (await rowsOf<{ id: string; updated_at: Date; origin: string; external_source: string | null; external_ref: string | null; received_at: string | null }>(db, 'tst', sql`
      select id, updated_at, origin, external_source, external_ref, received_at from document where doc_code = ${code} and deleted_at is null`))[0]!;
  const snapshotDoc = async (code: string) => (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle.docs.find((d) => d.id === code)!;

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
    docType = (await rowsOf<{ code: string }>(db, 'tst', sql`
      select code from ref.lookup_value where framework_version_id = ${isms.version} and domain = 'doc_type' order by sort_order limit 1`))[0]!.code;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('external documents (D.2)', () => {
    const external = () => ({
      docCode: 'EXT-01', title: 'Personal Data Protection Law', docType, ownerHandle: 'rina', classification: 'public', orgWide: false, linkedMs: ['isms'],
      origin: 'external', externalSource: 'Republic of Indonesia', externalRef: 'UU 27/2022', receivedAt: '2022-10-17',
    });

    it('registers an external document with its source, reference and date received; the snapshot marks it external', async () => {
      const created = await rina.post('/api/v1/ms/isms/documents', external());
      expect(created.status).toBe(201);
      expect(await docRow('EXT-01')).toMatchObject({ origin: 'external', external_source: 'Republic of Indonesia', external_ref: 'UU 27/2022', received_at: '2022-10-17' });
      const [audit] = await auditOf(db, 'tst', created.body.ref!.id);
      expect(audit!.after).toMatchObject({ origin: 'external', external_source: 'Republic of Indonesia', external_ref: 'UU 27/2022', received_at: '2022-10-17' });
      expect(await snapshotDoc('EXT-01')).toMatchObject({ origin: 'external' });
      // Internal documents keep the Milestone 1 shape.
      const internal = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle.docs.filter((d) => d.id !== 'EXT-01');
      expect(internal.length).toBeGreaterThan(0);
      expect(internal.every((d) => d.origin === undefined)).toBe(true);
    });

    it('refuses an external document without a source and external facts on an internal one', async () => {
      const { externalSource: _s, ...noSource } = external();
      expect((await rina.post('/api/v1/ms/isms/documents', { ...noSource, docCode: 'EXT-02' })).status).toBe(400);
      expect((await rina.post('/api/v1/ms/isms/documents', { ...external(), docCode: 'EXT-02', origin: 'internal' })).status).toBe(400);
    });

    it('changes the origin and external facts of a document, keeping an external one with a source', async () => {
      const [doc] = await rowsOf<{ code: string }>(db, 'tst', sql`
        select d.doc_code as code from document d join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null
         where l.management_system_id = ${isms.id} and d.deleted_at is null and d.origin = 'internal' and not d.is_org_wide order by d.doc_code limit 1`);
      const url = async () => `/api/v1/ms/isms/documents/${(await docRow(doc!.code)).id}`;
      expect((await rina.patch(await url(), { externalRef: 'v2' })).status).toBe(422);
      const toExternal = await rina.patch(await url(), { origin: 'external', externalSource: 'Bank Indonesia', externalRef: 'PBI 23/2021' });
      expect(toExternal.status).toBe(200);
      expect(await docRow(doc!.code)).toMatchObject({ origin: 'external', external_source: 'Bank Indonesia', external_ref: 'PBI 23/2021' });
      const noSource = await rina.patch(await url(), { externalSource: null });
      expect(noSource.status).toBe(422);
      expect(noSource.body).toMatchObject({ messageKey: 'documents.external_source_required' });
      expect((await rina.patch(await url(), { receivedAt: '2021-12-01' })).status).toBe(200);
      const back = await rina.patch(await url(), { origin: 'internal' });
      expect(back.status).toBe(200);
      expect(await docRow(doc!.code)).toMatchObject({ origin: 'internal', external_source: null, external_ref: null, received_at: null });
      expect((await auditOf(db, 'tst', (await docRow(doc!.code)).id)).at(-1)).toMatchObject({
        action: 'document.updated', before: expect.objectContaining({ origin: 'external', external_source: 'Bank Indonesia' }), after: expect.objectContaining({ origin: 'internal' }),
      });
    });
  });

  describe('document versions (D.1)', () => {
    let doc: { id: string; code: string };

    beforeAll(async () => {
      [doc] = await rowsOf<{ id: string; code: string }>(db, 'tst', sql`
        select d.id, d.doc_code as code from document d join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null
         where l.management_system_id = ${isms.id} and d.deleted_at is null and not d.is_org_wide and d.classification = 'internal'
           and not exists (select 1 from document_version v where v.document_id = d.id and v.status = 'in_review' and v.deleted_at is null)
         order by d.doc_code limit 1`) as [{ id: string; code: string }];
      const [bagusId, rinaId, dewiId] = [await idOf(db, 'tst', 'bagus'), await idOf(db, 'tst', 'rina'), await idOf(db, 'tst', 'dewi')];
      await inOrg(db, 'tst', async (trx) => {
        const { rows } = await sql<{ id: string }>`select storage_object_id as id from document_version where storage_object_id is not null limit 1`.execute(trx);
        const object = rows[0]!.id;
        await sql`update document_version set status = 'superseded' where document_id = ${doc.id} and status = 'approved'`.execute(trx);
        const { rows: approved } = await sql<{ id: string }>`
          insert into document_version (document_id, version_label, storage_object_id, status, submitted_by, submitted_at, approved_by, approved_at, change_summary, created_at)
          values (${doc.id}, 'v90.0', ${object}, 'approved', ${bagusId}, timestamptz '2026-08-01T03:00:00Z', ${rinaId}, date '2026-08-03', 'Roles of section 4 rewritten', now() + interval '1 hour')
          returning id`.execute(trx);
        await sql`insert into document_version (document_id, version_label, storage_object_id, status, submitted_by, submitted_at, rejection_note, created_at)
                  values (${doc.id}, 'v91.0', ${object}, 'rejected', ${dewiId}, timestamptz '2026-09-01T03:00:00Z', 'Annex B missing', now() + interval '2 hours')`.execute(trx);
        await sql`update document set current_version_id = ${approved[0]!.id} where id = ${doc.id}`.execute(trx);
      });
    });

    it('lists the versions newest first with submitter, approver, dates, rejection note and change summary', async () => {
      const response = await rina.get<DocumentVersionItem[]>(`/api/v1/ms/isms/documents/${doc.id}/versions`);
      expect(response.status).toBe(200);
      for (const v of response.body) expect(DocumentVersionItem.safeParse(v).success).toBe(true);
      expect(response.body.slice(0, 2)).toEqual([
        expect.objectContaining({ label: 'v91.0', status: 'rejected', submittedBy: 'dewi', approvedBy: null, rejectionNote: 'Annex B missing', changeSummary: null }),
        expect.objectContaining({ label: 'v90.0', status: 'approved', submittedBy: 'bagus', submittedAt: '2026-08-01T03:00:00.000Z', approvedBy: 'rina', approvedAt: '2026-08-03', changeSummary: 'Roles of section 4 rewritten' }),
      ]);
      // The snapshot names the change of the current version.
      expect(await snapshotDoc(doc.code)).toMatchObject({ changeSummary: 'Roles of section 4 rewritten' });
    });

    it('applies the scope policy of the document: Top Management sees no names, restricted documents only their owner and the managers', async () => {
      const top = await hendra.get<DocumentVersionItem[]>(`/api/v1/ms/isms/documents/${doc.id}/versions`);
      expect(top.status).toBe(200);
      // Top Management sees its own name only.
      expect(top.body.every((v) => [null, 'hendra'].includes(v.submittedBy) && [null, 'hendra'].includes(v.approvedBy))).toBe(true);
      expect(top.body.slice(0, 2).map((v) => [v.submittedBy, v.approvedBy])).toEqual([[null, null], [null, null]]);
      expect((await bagus.get(`/api/v1/ms/isms/documents/${doc.id}/versions`)).status).toBe(404);
      await inOrg(db, 'tst', (trx) => sql`update document set classification = 'restricted' where id = ${doc.id}`.execute(trx));
      expect((await maya.get(`/api/v1/ms/isms/documents/${doc.id}/versions`)).status).toBe(404);
      expect((await rina.get(`/api/v1/ms/isms/documents/${doc.id}/versions`)).status).toBe(200);
      expect((await rina.get('/api/v1/ms/isms/documents/0b7a4e7c-1d2f-4a3b-9c8d-7e6f5a4b3c2d/versions')).status).toBe(404);
    });
  });

  describe('management review changes (D.1)', () => {
    const create = async (client: Client, ms: string, code: string, linkedMs: string[]) => {
      const response = await client.post(`/api/v1/ms/${ms}/management-reviews`, { code, title: 'Management review 2027', plannedAt: '2027-03-01', ownerHandle: 'rina', linkedMs });
      expect(response.status).toBe(201);
      return response.body.ref!;
    };
    const reviewRow = async (org: 'tst' | 'ndt', id: string) =>
      (await rowsOf<{ updated_at: Date; title: string; planned_at: string; owner: string | null }>(db, org, sql`
        select r.updated_at, r.title, r.planned_at, u.handle as owner from management_review r left join platform.app_user u on u.id = r.owner_user_id where r.id = ${id}`))[0]!;

    it('changes title, planned date and owner of a planned review with If-Match, audited', async () => {
      const ref = await create(rina, 'isms', 'MR-X1', ['isms']);
      const url = `/api/v1/ms/isms/management-reviews/${ref.id}`;
      const changed = await rina.patch(url, { title: 'Management review 2027 (spring)', plannedAt: '2027-03-15', ownerHandle: 'hendra' }, { 'if-match': ref.etag! });
      expect(changed.status).toBe(200);
      expect(await reviewRow('tst', ref.id)).toMatchObject({ title: 'Management review 2027 (spring)', planned_at: '2027-03-15', owner: 'hendra' });
      expect((await auditOf(db, 'tst', ref.id)).at(-1)).toMatchObject({
        action: 'register.updated', actor: 'rina',
        before: { title: 'Management review 2027', planned_at: '2027-03-01', owner: 'rina' },
        after: { title: 'Management review 2027 (spring)', planned_at: '2027-03-15', owner: 'hendra' },
      });
      expect((await rina.patch(url, { title: 'Stale' }, { 'if-match': ref.etag! })).status).toBe(412);
      const same = await rina.patch(url, { plannedAt: '2027-03-15' });
      expect(same.body.message).toEqual(['Nothing to change', 'Tidak ada yang diubah']);
      expect((await bagus.patch(url, { title: 'x' })).status).toBe(403);
      expect((await rina.patch(url, {})).status).toBe(400);
      expect((await rina.patch(url, { linkedMs: ['isms', 'isms'] })).status).toBe(400);
      const away = await rina.patch(url, { linkedMs: ['qms'] });
      expect([404, 422]).toContain(away.status);
    });

    it('refuses a closed review (409)', async () => {
      const ref = await create(rina, 'isms', 'MR-X2', ['isms']);
      await inOrg(db, 'tst', (trx) => sql`
        update management_review set status = 'closed', held_at = date '2026-09-01', closed_at = date '2026-09-02', decisions_recorded = true,
               decisions_text = 'Budget approved' where id = ${ref.id}`.execute(trx));
      const closed = await rina.patch(`/api/v1/ms/isms/management-reviews/${ref.id}`, { title: 'Too late' });
      expect(closed.status).toBe(409);
      expect(closed.body).toMatchObject({ messageKey: 'audit.review_closed' });
    });

    it('links and unlinks other systems, with their mandatory inputs, keeping the path system', async () => {
      const ndtRina = await sessionFor(ctx, db, 'rina', 'ndt');
      const ref = await create(ndtRina, 'isms', 'MR-X3', ['isms']);
      const url = `/api/v1/ms/isms/management-reviews/${ref.id}`;
      const missing = await ndtRina.patch(url, { linkedMs: ['qms'] });
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({ messageKey: 'audit.path_system_not_linked' });
      const qms = await systemOf(db, 'ndt', 'qms');
      const [{ n: mandatory }] = await rowsOf<{ n: number }>(db, 'ndt', sql`
        select count(*)::int as n from ref.review_input_def where framework_version_id = ${qms.version} and mandatory`) as [{ n: number }];
      const joint = await ndtRina.patch(url, { linkedMs: ['isms', 'qms'] });
      expect(joint.status).toBe(200);
      expect(joint.body.changed).toEqual(['isms', 'qms']);
      const links = async () => (await rowsOf<{ slug: string; primary: boolean }>(db, 'ndt', sql`
        select m.slug, l.is_primary as primary from entity_ms_link l join management_system m on m.id = l.management_system_id
         where l.entity_type = 'management_review' and l.entity_id = ${ref.id} and l.deleted_at is null order by m.slug`));
      expect(await links()).toEqual([{ slug: 'isms', primary: true }, { slug: 'qms', primary: false }]);
      const [{ n: inputs }] = await rowsOf<{ n: number }>(db, 'ndt', sql`
        select count(*)::int as n from management_review_input where management_review_id = ${ref.id} and management_system_id = ${qms.id} and deleted_at is null`) as [{ n: number }];
      expect(inputs).toBe(mandatory);
      const back = await ndtRina.patch(url, { linkedMs: ['isms'] });
      expect(back.status).toBe(200);
      expect(await links()).toEqual([{ slug: 'isms', primary: true }]);
      expect((await auditOf(db, 'ndt', ref.id)).at(-1)).toMatchObject({ before: { linked_ms: ['isms', 'qms'] }, after: { linked_ms: ['isms'] } });
    });
  });
});
