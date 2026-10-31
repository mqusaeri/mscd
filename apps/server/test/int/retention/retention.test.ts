// Retention and disposal review against the demo data with a real storage gateway on SeaweedFS (Milestone 3 D.8, J.8,
// M3-06), with a fixed clock (the organisation's "today" is set per step): the rules marked default or set; every record
// class gets a review on the day its period ends and none before; `replaced_at` of a replaced evidence file and its
// backfill from the audit trail; keep and extend move the date and the item opens again as a new review; a hold keeps an
// item out of the review and the list; disposal of a current version, a held item, an item before its end and a record
// with open dependants is refused with its rule; the proposer cannot approve; an approved disposal deletes the vault
// content of a superseded version (opening it answers `content_disposed`) and keeps the version row and hash; a closed
// finding is marked deleted with `record.disposed`; a file in a Microsoft 365 repository asks its owner and "File
// removed" completes it; an approval refused after part of an evidence pack's vault content was deleted marks that part
// disposed and the next approval completes it; the register lists every decision with the period in force at the
// decision, also after a rule change, and downloads as CSV. Every vault delete runs against the bucket of this test's
// own SeaweedFS (R-20). Organisation `ndt`, system `qms` (rina and sari are its managers).
import { createHash } from 'node:crypto';
import type { CommandResult, Page, RetentionHoldItem, RetentionRegisterItem, RetentionReviewItem, RetentionRuleItem, UploadIntent, UploadResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GatewayProblemError } from '../../../src/modules/storage/gateway-client';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, signIn, startStorageStack, userId, type FilesClient, type StorageStack } from '../files/helpers';
import {
  auditOf, createRetentionApp, insertDocumentWithVersions, insertObject, msIdOf, repositoryIdOf, reviewsOf, rowsOf, vaultStat, type RetentionApp,
} from './helpers';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** The day the test items' periods start (12:00 in Jakarta for instants) and the end of a three month period. */
const START = '2026-06-15';
const START_AT = '2026-06-15T05:00:00Z';
const ENDS = '2026-09-15';

interface Problem {
  rule?: string;
  messageKey?: string;
  messages?: { en: string; id: string };
  errors?: { path: string; message: string }[];
  affected?: string[];
}

describe('retention and disposal review (Milestone 3 D.8)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: RetentionApp;
  let rina: FilesClient;
  let sari: FilesClient;
  let bagus: FilesClient;
  let qms: string;
  let vault: string;
  let sp: string;
  let docType: string;
  /** Items of every class created in the class test, by class. */
  const items: Record<string, string> = {};
  let currentVersionId = '';

  const url = (p: string) => `/api/v1/ms/qms/retention${p}`;
  const openReviewOf = async (itemId: string) => (await reviewsOf(db, 'ndt', itemId)).find((r) => r.status === 'open' || r.status === 'awaiting_approval');
  const putRule = (client: FilesClient, recordClass: string, body: Record<string, unknown>) => client.call<CommandResult & Problem>('PUT', url(`/rules/${recordClass}`), body);

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createRetentionApp(db, stack.gateway.url);
    rina = await signIn(ctx as never, db, 'rina', 'ndt');
    sari = await signIn(ctx as never, db, 'sari', 'ndt');
    bagus = await signIn(ctx as never, db, 'bagus', 'ndt');
    qms = await msIdOf(db, 'ndt', 'qms');
    vault = await repositoryIdOf(db, 'ndt', 'vault');
    sp = await repositoryIdOf(db, 'ndt', 'sp');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('lists the period in force per class and document type, marked default or set, and sets and resets a rule', async () => {
    const listed = await rina.get<RetentionRuleItem[]>(url('/rules'));
    expect(listed.status).toBe(200);
    const versions = listed.body.filter((r) => r.recordClass === 'document_version');
    expect(versions.length).toBeGreaterThan(2);
    expect(versions[0]).toMatchObject({ docType: expect.any(String), docTypeLabel: [expect.any(String), expect.any(String)], retainMonths: 36, source: 'default' });
    expect(listed.body.filter((r) => r.recordClass !== 'document_version').map((r) => r.recordClass)).toEqual([
      'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record',
    ]);
    expect(listed.body.every((r) => r.retainMonths === 36 && r.source === 'default')).toBe(true);
    docType = versions.find((v) => v.docType === 'procedure')?.docType ?? versions[0]!.docType!;

    // The approver (a Programme Owner or another manager) reads; a Domain Owner does not.
    expect((await bagus.get(url('/rules'))).status).toBe(403);

    const set = await putRule(rina, 'finding', { retainMonths: 60, basis: 'Customer contract clause 12.3' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const after = await rina.get<RetentionRuleItem[]>(url('/rules'));
    expect(after.body.find((r) => r.recordClass === 'finding')).toMatchObject({ retainMonths: 60, source: 'set', basis: 'Customer contract clause 12.3' });
    expect((await putRule(rina, 'finding', { retainMonths: 60, basis: 'Customer contract clause 12.3' })).body.message).toEqual(['Nothing to change', 'Tidak ada yang diubah']);
    const reset = await putRule(rina, 'finding', { retainMonths: null, basis: 'Back to one certification cycle' });
    expect(reset.status).toBe(200);
    expect((await rina.get<RetentionRuleItem[]>(url('/rules'))).body.find((r) => r.recordClass === 'finding')).toMatchObject({ retainMonths: 36, source: 'default', basis: null });
    const audit = await rowsOf<{ before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
      db, 'ndt', sql`select before_data, after_data from audit_trail where action = 'retention_rule.changed' and entity_code = 'finding' order by seq`,
    );
    expect(audit.map((a) => a.after_data.source)).toEqual(['set', 'default']);

    expect((await putRule(rina, 'document_version', { retainMonths: 12, basis: 'x' })).body.errors?.[0]?.path).toBe('body.docType');
    expect((await putRule(rina, 'finding', { docType: 'policy', retainMonths: 12, basis: 'x' })).status).toBe(400);
    expect((await putRule(rina, 'document_version', { docType: 'no_such_type', retainMonths: 12, basis: 'x' })).status).toBe(404);
    expect((await putRule(sari, 'finding', { retainMonths: 0, basis: 'x' })).status).toBe(400);
  });

  it('opens a review for an item of every class on the day its period ends and none before', async () => {
    const rinaId = rina.userId;
    const sariId = sari.userId;
    const bagusId = bagus.userId;
    for (const recordClass of ['evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record']) {
      expect((await putRule(rina, recordClass, { retainMonths: 3, basis: 'Short period of the test' })).status).toBe(200);
    }
    expect((await putRule(rina, 'document_version', { docType, retainMonths: 3, basis: 'Short period of the test' })).status).toBe(200);

    await inOrg(db, 'ndt', async (trx) => {
      const oldObject = await insertObject(trx, vault, 'Procedure v1.pdf', rinaId);
      const currentObject = await insertObject(trx, vault, 'Procedure v2.pdf', rinaId);
      const doc = await insertDocumentWithVersions(trx, {
        msId: qms, code: 'RET-DOC-1', docType, ownerId: sariId, oldObjectId: oldObject, currentObjectId: currentObject, oldApprovedOn: '2025-01-10', replacedOn: START,
      });
      items.document_version = doc.oldVersionId;
      currentVersionId = doc.currentVersionId;

      const evidenceObject = await insertObject(trx, vault, 'Calibration log.pdf', rinaId);
      const evidence = await trx
        .insertInto('evidence')
        .values({ evidence_code: 'RET-EV-1', title: 'Calibration log of a retired instrument', owner_user_id: sariId, frequency_code: 'annual', storage_object_id: evidenceObject, produced_at: '2025-06-01', deleted_at: new Date(START_AT) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'evidence', entity_id: evidence.id, management_system_id: qms, is_primary: true }).execute();
      items.evidence_file = evidenceObject;

      const manifest = await insertObject(trx, vault, 'manifest.csv', rinaId);
      const pack = await trx
        .insertInto('evidence_pack')
        .values({ management_system_id: qms, status: 'ready', pack_folder: '/Compliance/_packs/QMS/2026-06-15/', manifest_csv_object_id: manifest, built_at: new Date(START_AT), created_by: rinaId })
        .returning('id')
        .executeTakeFirstOrThrow();
      items.evidence_pack = pack.id;

      const event = await trx
        .insertInto('audit_event')
        .values({ management_system_id: qms, event_type: 'special', name_en: 'Special audit 2026', name_id: 'Audit khusus 2026', short_label: 'RET-AE-1', scheduled_at: '2026-06-13', audit_days: 3, outcome: 'recommended' })
        .returning('id')
        .executeTakeFirstOrThrow();
      items.audit_event = event.id;

      const finding = await trx
        .insertInto('finding')
        .values({ management_system_id: qms, code: 'RET-F-1', title: 'Late supplier review', classification: 'minor', source: 'other', status: 'closed', closed_at: START, owner_user_id: sariId })
        .returning('id')
        .executeTakeFirstOrThrow();
      items.finding = finding.id;

      const action = await trx
        .insertInto('corrective_action')
        .values({
          management_system_id: qms, code: 'RET-CA-1', title: 'Supplier review schedule', owner_user_id: sariId, status: 'closed', implemented_by_user_id: bagusId,
          implemented_at: '2026-06-01', verified_by_user_id: rinaId, verified_at: START, effective: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      items.corrective_action = action.id;

      const review = await trx
        .insertInto('management_review')
        .values({ code: 'RET-MR-1', title: 'Management review H1 2026', owner_user_id: sariId, status: 'closed', decisions_recorded: true, closed_at: START, held_at: '2026-06-10' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'management_review', entity_id: review.id, management_system_id: qms, is_primary: true }).execute();
      items.management_review = review.id;

      const competence = await trx
        .insertInto('competence_record')
        .values({ user_id: bagusId, role_title: 'Internal auditor (lapsed)', competence_required: 'ISO 9001 internal auditor course', proof_type: 'training', achieved_at: '2024-01-10', valid_until: START, owner_user_id: sariId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'competence_record', entity_id: competence.id, management_system_id: qms, is_primary: true }).execute();
      items.competence_record = competence.id;
    });

    ctx.setToday('2026-09-14');
    await ctx.review('ndt');
    for (const [recordClass, itemId] of Object.entries(items)) expect(await reviewsOf(db, 'ndt', itemId), recordClass).toEqual([]);

    ctx.setToday(ENDS);
    const run = await ctx.review('ndt');
    expect(run.bySystem.qms).toBeGreaterThanOrEqual(8);
    for (const [recordClass, itemId] of Object.entries(items)) {
      const reviews = await reviewsOf(db, 'ndt', itemId);
      expect(reviews, recordClass).toHaveLength(1);
      expect(reviews[0], recordClass).toMatchObject({ record_class: recordClass, management_system_id: qms, status: 'open', retention_ends_on: ENDS });
    }
    expect((await reviewsOf(db, 'ndt', items.document_version!))[0]).toMatchObject({ item_code: 'RET-DOC-1 v1.0', item_title: 'Retention test RET-DOC-1' });
    expect((await reviewsOf(db, 'ndt', items.competence_record!))[0]!.item_title).toBe('Internal auditor (lapsed)');
    // The current version never gets a review.
    expect(await reviewsOf(db, 'ndt', currentVersionId)).toEqual([]);

    // A second run of the day opens nothing again.
    await ctx.review('ndt');
    for (const itemId of Object.values(items)) expect(await reviewsOf(db, 'ndt', itemId)).toHaveLength(1);

    // The managers of the system get the digest notice.
    const notices = await rowsOf<{ recipient_user_id: string; digest: boolean }>(
      db, 'ndt', sql`select recipient_user_id, digest from notification where kind = 'retention_review_due' and management_system_id = ${qms}`,
    );
    expect(new Set(notices.map((n) => n.recipient_user_id))).toEqual(new Set([rinaId, sariId]));
    expect(notices.every((n) => n.digest)).toBe(true);

    // The list shows them, filtered by class and by record code.
    const list = await rina.get<Page<RetentionReviewItem>>(url('/reviews?status=open&recordClass=finding'));
    expect(list.status).toBe(200);
    expect(list.body.items.map((r) => r.itemCode)).toContain('RET-F-1');
    expect(list.body.items.every((r) => r.recordClass === 'finding' && r.status === 'open' && !r.onHold)).toBe(true);
    const byCode = await rina.get<Page<RetentionReviewItem>>(url('/reviews?code=RET-DOC-1'));
    expect(byCode.body.items.map((r) => r.itemCode)).toEqual(['RET-DOC-1 v1.0']);
    expect(byCode.body.total).toBe(1);
  });

  it('sets replaced_at when an evidence file is replaced, and fills it for older replacements from the audit trail', async () => {
    const evidence = await inOrg(db, 'ndt', async (trx) => {
      const { rows } = await sql<{ id: string; evidence_code: string }>`
        select e.id, e.evidence_code from evidence e
          join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null and l.is_primary
          join storage_object o on o.id = e.storage_object_id
          join storage_repository r on r.id = o.storage_repository_id and r.adapter = 'managed_vault'
          join platform.app_user u on u.id = e.owner_user_id and u.handle = 'sari'
         where e.deleted_at is null and l.management_system_id = ${qms} order by e.evidence_code limit 1`.execute(trx);
      return rows[0]!;
    });
    const attach = async (name: string) => {
      const intent = await sari.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: evidence.id, fileName: name, size: PDF.length });
      expect(intent.status, JSON.stringify(intent.body)).toBe(201);
      const put = await sari.put<UploadResult>(intent.body.contentUrl!, PDF);
      expect(put.status).toBe(200);
      const attached = await sari.post(`/api/v1/ms/qms/evidence/${evidence.id}/files`, { source: 'upload', uploadIntentId: intent.body.intentId, mode: 'submit' });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      return put.body.storageObjectId;
    };
    const first = await attach('Supplier evaluation A.pdf');
    const second = await attach('Supplier evaluation B.pdf');
    const objects = await inOrg(db, 'ndt', (trx) => trx.selectFrom('storage_object').select(['id', 'replaced_at']).where('id', 'in', [first, second]).execute());
    expect(objects.find((o) => o.id === first)!.replaced_at).toBeInstanceOf(Date);
    expect(objects.find((o) => o.id === second)!.replaced_at).toBeNull();

    // An older replacement (before M3-06) has no replaced_at: the job fills it from the entry that replaced the file.
    await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_object').set({ replaced_at: null }).where('id', '=', first).execute());
    const run = await ctx.review('ndt');
    expect(run.backfilled).toBeGreaterThanOrEqual(1);
    const [entry] = await rowsOf<{ occurred_at: Date }>(
      db, 'ndt', sql`select occurred_at from audit_trail where entity_id = ${evidence.id} and action = 'evidence.file_uploaded' and before_data->>'storageObjectId' = ${first} order by seq limit 1`,
    );
    const filled = await inOrg(db, 'ndt', (trx) => trx.selectFrom('storage_object').select('replaced_at').where('id', '=', first).executeTakeFirstOrThrow());
    expect(filled.replaced_at!.toISOString()).toBe(entry!.occurred_at.toISOString());

    // The earlier file is an item of its evidence item, named by evidence code and version, with its replacement date.
    await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_object').set({ replaced_at: new Date(START_AT) }).where('id', '=', first).execute());
    await ctx.review('ndt');
    const [review] = await reviewsOf(db, 'ndt', first);
    expect(review).toMatchObject({ record_class: 'evidence_file', status: 'open', retention_ends_on: ENDS });
    expect(review!.item_code).toMatch(new RegExp(`^${evidence.evidence_code} v\\d+$`));
    expect(await reviewsOf(db, 'ndt', second)).toEqual([]);
  });

  it('keeps an item until a date and extends another; each opens again as a new review on its new date', async () => {
    const finding = (await openReviewOf(items.finding!))!;
    const event = (await openReviewOf(items.audit_event!))!;
    const tooEarly = await rina.post<Problem>(url('/reviews/decide'), { ids: [finding.id], decision: 'keep', reason: 'Needed later', keepUntil: ENDS });
    expect(tooEarly.status).toBe(400);
    const kept = await rina.post<CommandResult>(url('/reviews/decide'), { ids: [finding.id], decision: 'keep', reason: 'Needed for the 2027 recertification', keepUntil: '2026-12-31' });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.count).toBe(1);
    const extended = await rina.post<CommandResult>(url('/reviews/decide'), { ids: [event.id], decision: 'extend', reason: 'Open customer dispute', extendMonths: 6 });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);
    expect((await reviewsOf(db, 'ndt', items.finding!))[0]).toMatchObject({ status: 'kept', decision: 'keep', keep_until: '2026-12-31', decided_by: rina.userId, reason: 'Needed for the 2027 recertification' });
    expect((await reviewsOf(db, 'ndt', items.audit_event!))[0]).toMatchObject({ status: 'extended', decision: 'extend', retention_ends_on: '2027-03-15' });
    const again = await rina.post<Problem>(url('/reviews/decide'), { ids: [finding.id], decision: 'dispose', reason: 'x' });
    expect(again.status).toBe(409);
    expect((await auditOf(db, 'ndt', finding.id)).map((a) => a.action)).toEqual(['retention_review.decided']);

    ctx.setToday('2026-12-30');
    await ctx.review('ndt');
    expect(await reviewsOf(db, 'ndt', items.finding!)).toHaveLength(1);
    ctx.setToday('2026-12-31');
    await ctx.review('ndt');
    const findingReviews = await reviewsOf(db, 'ndt', items.finding!);
    expect(findingReviews.map((r) => [r.status, r.retention_ends_on])).toEqual([['kept', ENDS], ['open', '2026-12-31']]);

    ctx.setToday('2027-03-14');
    await ctx.review('ndt');
    expect(await reviewsOf(db, 'ndt', items.audit_event!)).toHaveLength(1);
    ctx.setToday('2027-03-15');
    await ctx.review('ndt');
    expect((await reviewsOf(db, 'ndt', items.audit_event!)).map((r) => [r.status, r.retention_ends_on])).toEqual([['extended', '2027-03-15'], ['open', '2027-03-15']]);
    ctx.setToday(ENDS);
  });

  it('keeps a held item out of the review and the list, and releases the hold with a reason', async () => {
    const reviewBefore = (await openReviewOf(items.management_review!))!;
    const held = await rina.post<CommandResult>(url('/holds'), { recordClass: 'management_review', itemCode: 'RET-MR-1', reason: 'Legal claim by a former supplier' });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect((await rina.post<Problem>(url('/holds'), { recordClass: 'management_review', itemId: items.management_review, reason: 'Again' })).status).toBe(409);
    const open = await rina.get<Page<RetentionReviewItem>>(url('/reviews?status=open&recordClass=management_review'));
    expect(open.body.items.map((r) => r.itemCode)).not.toContain('RET-MR-1');
    const dispose = await rina.post<Problem>(url('/reviews/decide'), { ids: [reviewBefore.id], decision: 'dispose', reason: 'Period over' });
    expect(dispose.status).toBe(422);
    expect(dispose.body).toMatchObject({ rule: 'RET-HOLD', messageKey: 'rule.RET-HOLD', affected: ['RET-MR-1'] });
    expect(dispose.body.messages?.en).toContain('RET-MR-1');

    // A hold set before the period ends keeps the review from opening at all.
    const second = await inOrg(db, 'ndt', async (trx) =>
      (await trx
        .insertInto('corrective_action')
        .values({
          management_system_id: qms, code: 'RET-CA-2', title: 'Held action', owner_user_id: sari.userId, status: 'closed', implemented_by_user_id: bagus.userId,
          implemented_at: '2026-06-01', verified_by_user_id: rina.userId, verified_at: START, effective: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    expect((await rina.post(url('/holds'), { recordClass: 'corrective_action', itemCode: 'RET-CA-2', reason: 'Investigation' })).status).toBe(201);
    await ctx.review('ndt');
    expect(await reviewsOf(db, 'ndt', second)).toEqual([]);

    const holds = await rina.get<RetentionHoldItem[]>(url('/holds'));
    expect(holds.body.slice(0, 2).map((h) => h.itemCode).sort()).toEqual(['RET-CA-2', 'RET-MR-1']);
    const hold = holds.body.find((h) => h.itemCode === 'RET-MR-1')!;
    expect(hold).toMatchObject({ recordClass: 'management_review', reason: 'Legal claim by a former supplier', setBy: { handle: 'rina' }, releasedAt: null });
    expect((await rina.post(url(`/holds/${hold.id}/release`), { reason: 'Claim settled' })).status).toBe(200);
    expect((await rina.post<Problem>(url(`/holds/${hold.id}/release`), { reason: 'Claim settled' })).status).toBe(409);
    const released = (await rina.get<RetentionHoldItem[]>(url('/holds'))).body.find((h) => h.id === hold.id)!;
    expect(released).toMatchObject({ releasedBy: { handle: 'rina' }, releaseReason: 'Claim settled' });
    expect((await rina.get<Page<RetentionReviewItem>>(url('/reviews?status=open&recordClass=management_review'))).body.items.map((r) => r.itemCode)).toContain('RET-MR-1');
    // An unknown code or an item of another system is not found.
    expect((await rina.post(url('/holds'), { recordClass: 'finding', itemCode: 'NO-SUCH-1', reason: 'x' })).status).toBe(404);
    expect((await sari.post(url('/holds'), { recordClass: 'finding', itemId: items.finding, reason: 'x' })).status).toBe(201);
    expect((await bagus.post(url('/holds'), { recordClass: 'finding', itemId: items.finding, reason: 'x' })).status).toBe(403);
  });

  it('refuses disposal of a current version, an item before its end and a record with open dependants', async () => {
    const current = await inOrg(db, 'ndt', async (trx) =>
      (await trx
        .insertInto('retention_review')
        .values({ management_system_id: qms, record_class: 'document_version', item_id: currentVersionId, item_code: 'RET-DOC-1 v2.0', retention_ends_on: '2026-01-01' })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    const refusedCurrent = await rina.post<Problem>(url('/reviews/decide'), { ids: [current], decision: 'dispose', reason: 'Period over' });
    expect(refusedCurrent.status).toBe(422);
    expect(refusedCurrent.body).toMatchObject({ rule: 'RET-CURRENT', affected: ['RET-DOC-1 v2.0'] });

    // A longer period set after the review opened moves the end: the item is not due yet.
    const competence = (await openReviewOf(items.competence_record!))!;
    expect((await putRule(rina, 'competence_record', { retainMonths: 24, basis: 'Two years for training records' })).status).toBe(200);
    const notDue = await rina.post<Problem>(url('/reviews/decide'), { ids: [competence.id], decision: 'dispose', reason: 'Period over' });
    expect(notDue.status).toBe(422);
    expect(notDue.body.rule).toBe('RET-NOT-DUE');
    expect(notDue.body.messages?.en).toContain('2028-06-15');
    expect((await putRule(rina, 'competence_record', { retainMonths: 3, basis: 'Short period of the test' })).status).toBe(200);

    const withAction = await inOrg(db, 'ndt', async (trx) => {
      const finding = await trx
        .insertInto('finding')
        .values({ management_system_id: qms, code: 'RET-F-2', title: 'Finding with an open action', classification: 'minor', source: 'other', status: 'closed', closed_at: START, owner_user_id: sari.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      const action = await trx
        .insertInto('corrective_action')
        .values({ management_system_id: qms, code: 'RET-CA-3', title: 'Open action', owner_user_id: sari.userId, status: 'action' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('corrective_action_finding').values({ corrective_action_id: action.id, finding_id: finding.id }).execute();
      return finding.id;
    });
    await ctx.review('ndt');
    const dependantReview = (await openReviewOf(withAction))!;
    const refusedDependants = await rina.post<Problem>(url('/reviews/decide'), { ids: [dependantReview.id], decision: 'dispose', reason: 'Period over' });
    expect(refusedDependants.status).toBe(422);
    expect(refusedDependants.body).toMatchObject({ messageKey: 'records.open_dependants', affected: ['RET-CA-3'] });
    // One refused item refuses the whole decision.
    expect((await reviewsOf(db, 'ndt', withAction))[0]!.status).toBe('open');
  });

  it('lets a second person approve a disposal, which deletes the vault content of a superseded version and keeps its row and hash', async () => {
    const versionObject = await inOrg(db, 'ndt', async (trx) => {
      const placeholder = await insertObject(trx, vault, 'Placeholder.pdf', rina.userId);
      const doc = await trx
        .insertInto('document')
        .values({ doc_code: 'RET-DOC-2', title: 'Supplier control procedure', doc_type: docType, status: 'approved', owner_user_id: sari.userId, approved_at: START, next_review_at: '2027-09-01' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'document', entity_id: doc.id, management_system_id: qms, is_primary: true }).execute();
      const current = await trx
        .insertInto('document_version')
        .values({ document_id: doc.id, version_label: '2.0', storage_object_id: placeholder, status: 'approved', approved_at: START, created_at: new Date(`${START}T01:00:00Z`) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.updateTable('document').set({ current_version_id: current.id }).where('id', '=', doc.id).execute();
      return doc.id;
    });
    const intent = await rina.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'document', recordId: versionObject, fileName: 'Supplier control procedure v1.pdf', size: PDF.length });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    expect(intent.body.repository.adapter).toBe('managed_vault');
    const put = await rina.put<UploadResult>(intent.body.contentUrl!, PDF);
    expect(put.status).toBe(200);
    const objectId = put.body.storageObjectId;
    const versionId = await inOrg(db, 'ndt', async (trx) =>
      (await trx
        .insertInto('document_version')
        .values({ document_id: versionObject, version_label: '1.0', storage_object_id: objectId, status: 'superseded', approved_at: '2025-01-10', created_at: new Date('2025-01-10T01:00:00Z') })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    expect(await vaultStat(ctx, db, 'ndt', objectId)).toBe('found');
    await ctx.review('ndt');
    const review = (await openReviewOf(versionId))!;
    expect(review.item_code).toBe('RET-DOC-2 v1.0');

    const proposed = await rina.post<CommandResult>(url('/reviews/decide'), { ids: [review.id], decision: 'dispose', reason: 'Superseded more than three months ago' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect((await reviewsOf(db, 'ndt', versionId))[0]).toMatchObject({ status: 'awaiting_approval', decision: 'dispose', decided_by: rina.userId });
    const pending = await rowsOf<{ recipient_user_id: string }>(db, 'ndt', sql`select recipient_user_id from notification where kind = 'disposal_approval_pending' and management_system_id = ${qms}`);
    expect(pending.map((p) => p.recipient_user_id)).toContain(sari.userId);
    expect(pending.map((p) => p.recipient_user_id)).not.toContain(rina.userId);
    const awaiting = await sari.get<Page<RetentionReviewItem>>(url('/reviews?status=awaiting_approval'));
    expect(awaiting.body.items.find((r) => r.id === review.id)).toMatchObject({ decidedBy: { handle: 'rina' }, reason: 'Superseded more than three months ago' });

    const self = await rina.post<Problem>(url(`/reviews/${review.id}/approve`), {});
    expect(self.status).toBe(422);
    expect(self.body).toMatchObject({ rule: 'SOD-SELF-APPROVE' });
    expect((await bagus.post(url(`/reviews/${review.id}/approve`), {})).status).toBe(403);

    const approved = await sari.post<CommandResult>(url(`/reviews/${review.id}/approve`), {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ fileAction: 'vault_content_deleted', vaultObjects: 1 });
    expect((await reviewsOf(db, 'ndt', versionId))[0]).toMatchObject({ status: 'disposed', approved_by: sari.userId, file_action: 'vault_content_deleted' });
    expect((await reviewsOf(db, 'ndt', versionId))[0]!.disposed_at).toBeInstanceOf(Date);
    expect(await vaultStat(ctx, db, 'ndt', objectId)).not.toBe('found');
    const opened = await sari.get<Problem>(`/api/v1/storage/objects/${objectId}/open?ms=qms`);
    expect(opened.status).toBe(404);
    expect(opened.body.messageKey).toBe('content_disposed');
    const kept = await inOrg(db, 'ndt', async (trx) => ({
      version: await trx.selectFrom('document_version').selectAll().where('id', '=', versionId).executeTakeFirstOrThrow(),
      object: await trx.selectFrom('storage_object').selectAll().where('id', '=', objectId).executeTakeFirstOrThrow(),
    }));
    expect(kept.version).toMatchObject({ version_label: '1.0', storage_object_id: objectId, status: 'superseded', deleted_at: null });
    expect(kept.object).toMatchObject({ hash_value: sha256(PDF), content_disposed_by: sari.userId });
    expect(kept.object.content_disposed_at).toBeInstanceOf(Date);
    expect((await auditOf(db, 'ndt', versionId)).map((a) => a.action)).toEqual(['record.disposed']);
    expect((await auditOf(db, 'ndt', review.id)).map((a) => a.action)).toEqual(['retention_review.decided', 'retention_review.approved']);
    expect((await sari.post<Problem>(url(`/reviews/${review.id}/approve`), {})).status).toBe(409);
    // The disposed version never opens again.
    await ctx.review('ndt');
    expect(await reviewsOf(db, 'ndt', versionId)).toHaveLength(1);
  });

  it('sends a disposal back to review with a note', async () => {
    const pack = (await openReviewOf(items.evidence_pack!))!;
    expect((await rina.post(url('/reviews/decide'), { ids: [pack.id], decision: 'dispose', reason: 'Older than the period' })).status).toBe(200);
    const rejected = await sari.post<CommandResult>(url(`/reviews/${pack.id}/reject`), { note: 'The auditor asked to keep it until the next audit' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await reviewsOf(db, 'ndt', items.evidence_pack!))[0]).toMatchObject({ status: 'open', decision: null, rejected_note: 'The auditor asked to keep it until the next audit' });
    expect((await sari.post(url(`/reviews/${pack.id}/reject`), { note: 'Again' })).status).toBe(409);
  });

  it('marks a closed finding deleted with record.disposed', async () => {
    const finding = await inOrg(db, 'ndt', async (trx) =>
      (await trx
        .insertInto('finding')
        .values({ management_system_id: qms, code: 'RET-F-3', title: 'Calibration overdue', classification: 'minor', source: 'internal_audit', status: 'closed', closed_at: START, owner_user_id: sari.userId })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    await ctx.review('ndt');
    const review = (await openReviewOf(finding))!;
    expect((await sari.post(url('/reviews/decide'), { ids: [review.id], decision: 'dispose', reason: 'Closed and verified; period over' })).status).toBe(200);
    const approved = await rina.post<CommandResult>(url(`/reviews/${review.id}/approve`), {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ fileAction: 'none', recordDeleted: true });
    const row = await inOrg(db, 'ndt', (trx) => trx.selectFrom('finding').select(['deleted_at', 'updated_by']).where('id', '=', finding).executeTakeFirstOrThrow());
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.updated_by).toBe(rina.userId);
    const [entry] = await auditOf(db, 'ndt', finding);
    expect(entry).toMatchObject({
      action: 'record.disposed', entity_type: 'finding', entity_code: 'RET-F-3', actor_user_id: rina.userId,
      after_data: { deleted: true, recordClass: 'finding', reviewId: review.id, fileAction: 'none', reason: 'Closed and verified; period over' },
    });
  });

  it('asks the owner to delete a file kept in a Microsoft 365 repository, and records "File removed"', async () => {
    const versionId = await inOrg(db, 'ndt', async (trx) => {
      const old = await insertObject(trx, sp, 'Customer complaint procedure v1.docx', rina.userId);
      const current = await insertObject(trx, sp, 'Customer complaint procedure v2.docx', rina.userId);
      return (await insertDocumentWithVersions(trx, { msId: qms, code: 'RET-DOC-3', docType, ownerId: sari.userId, oldObjectId: old, currentObjectId: current, oldApprovedOn: '2024-03-01', replacedOn: START })).oldVersionId;
    });
    await ctx.review('ndt');
    const review = (await openReviewOf(versionId))!;
    expect((await rina.post(url('/reviews/decide'), { ids: [review.id], decision: 'dispose', reason: 'Superseded; period over' })).status).toBe(200);
    const approved = await sari.post<CommandResult>(url(`/reviews/${review.id}/approve`), {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ fileAction: 'owner_asked' });
    expect(approved.body.message?.[0]).toContain('owner is asked');
    const task = await rowsOf<{ id: string; owner_user_id: string; status: string; source_rule: string; title_en: string }>(
      db, 'ndt', sql`select id, owner_user_id, status, source_rule, title_en from task where entity_type = 'retention_review' and entity_id = ${review.id}`,
    );
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ owner_user_id: sari.userId, status: 'open', source_rule: 'manual' });
    expect(task[0]!.title_en).toContain('SharePoint Online');
    const objectId = (await inOrg(db, 'ndt', (trx) => trx.selectFrom('document_version').select('storage_object_id').where('id', '=', versionId).executeTakeFirstOrThrow())).storage_object_id;
    const object = await inOrg(db, 'ndt', (trx) => trx.selectFrom('storage_object').select(['content_disposed_at', 'deleted_at']).where('id', '=', objectId).executeTakeFirstOrThrow());
    expect(object.content_disposed_at).toBeInstanceOf(Date);
    expect(object.deleted_at).toBeNull();

    expect((await bagus.post(url(`/reviews/${review.id}/file-removed`), {})).status).toBe(403);
    const removed = await rina.post<CommandResult>(url(`/reviews/${review.id}/file-removed`), {});
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await reviewsOf(db, 'ndt', versionId))[0]).toMatchObject({ file_removed_by: rina.userId });
    expect((await reviewsOf(db, 'ndt', versionId))[0]!.file_removed_at).toBeInstanceOf(Date);
    const done = await rowsOf<{ status: string }>(db, 'ndt', sql`select status from task where id = ${task[0]!.id}`);
    expect(done[0]!.status).toBe('done');
    expect((await rina.post(url(`/reviews/${review.id}/file-removed`), {})).status).toBe(409);
    expect((await auditOf(db, 'ndt', review.id)).map((a) => a.action)).toEqual(['retention_review.decided', 'retention_review.approved', 'retention_review.file_removed']);
  });

  it('marks vault content already deleted as disposed when a later delete of the approval is refused, and completes on the next approval', async () => {
    // An evidence pack with two vault objects that hold bytes (uploaded through a document's upload intent).
    const holder = await inOrg(db, 'ndt', async (trx) => {
      const placeholder = await insertObject(trx, vault, 'Holder placeholder.pdf', rina.userId);
      const doc = await trx
        .insertInto('document')
        .values({ doc_code: 'RET-DOC-4', title: 'Pack upload holder', doc_type: docType, status: 'approved', owner_user_id: sari.userId, approved_at: START, next_review_at: '2027-09-01' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'document', entity_id: doc.id, management_system_id: qms, is_primary: true }).execute();
      const current = await trx
        .insertInto('document_version')
        .values({ document_id: doc.id, version_label: '1.0', storage_object_id: placeholder, status: 'approved', approved_at: START, created_at: new Date(`${START}T01:00:00Z`) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.updateTable('document').set({ current_version_id: current.id }).where('id', '=', doc.id).execute();
      return doc.id;
    });
    const upload = async (fileName: string) => {
      const intent = await rina.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'document', recordId: holder, fileName, size: PDF.length });
      expect(intent.status, JSON.stringify(intent.body)).toBe(201);
      const put = await rina.put<UploadResult>(intent.body.contentUrl!, PDF);
      expect(put.status).toBe(200);
      return put.body.storageObjectId;
    };
    const archive = await upload('pack-archive.pdf');
    const manifest = await upload('pack-manifest.pdf');
    const packId = await inOrg(db, 'ndt', async (trx) =>
      (await trx
        .insertInto('evidence_pack')
        .values({ management_system_id: qms, status: 'ready', pack_folder: '/Compliance/_packs/QMS/2026-06-16/', archive_object_id: archive, manifest_pdf_object_id: manifest, built_at: new Date(START_AT), created_by: rina.userId })
        .returning('id')
        .executeTakeFirstOrThrow()).id,
    );
    const externalIds = new Map(
      (await rowsOf<{ id: string; external_item_id: string }>(db, 'ndt', sql`select id, external_item_id from storage_object where id in (${archive}, ${manifest})`)).map((o) => [o.external_item_id, o.id]),
    );
    await ctx.review('ndt');
    const review = (await openReviewOf(packId))!;
    expect((await rina.post(url('/reviews/decide'), { ids: [review.id], decision: 'dispose', reason: 'Pack older than the period' })).status).toBe(200);

    // The gateway refuses the second delete under a bucket retention rule, after the first object's content is gone.
    const realPost = ctx.gateway.post.bind(ctx.gateway);
    const deletes: string[] = [];
    const spy = vi.spyOn(ctx.gateway, 'post').mockImplementation((async (path: string, body: unknown, options?: { requestId?: string; signal?: AbortSignal }) => {
      if (path === '/v1/objects/delete') {
        deletes.push((body as { object: { externalItemId: string } }).object.externalItemId);
        if (deletes.length === 2) {
          throw new GatewayProblemError('forbidden', 403, 'A retention rule of the bucket protects the object until 2027-03-01T00:00:00.000Z; it is not deleted', undefined, undefined);
        }
      }
      return realPost(path, body, options);
    }) as never);
    const refused = await sari.post<Problem>(url(`/reviews/${review.id}/approve`), {}).finally(() => spy.mockRestore());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.messageKey).toBe('retention.kept_by_bucket_rule');
    expect(refused.body.messages?.en).toContain('2027-03-01');
    expect(deletes).toHaveLength(2);
    const first = externalIds.get(deletes[0]!)!;
    const second = externalIds.get(deletes[1]!)!;
    expect(new Set([first, second])).toEqual(new Set([archive, manifest]));

    // The deleted object is marked disposed in a step of its own; the refused one keeps its content; the review waits.
    expect((await reviewsOf(db, 'ndt', packId))[0]).toMatchObject({ status: 'awaiting_approval', approved_by: null });
    const objects = async () =>
      new Map((await rowsOf<{ id: string; content_disposed_at: Date | null; content_disposed_by: string | null }>(
        db, 'ndt', sql`select id, content_disposed_at, content_disposed_by from storage_object where id in (${archive}, ${manifest})`,
      )).map((o) => [o.id, o]));
    const marked = await objects();
    expect(marked.get(first)!.content_disposed_at).toBeInstanceOf(Date);
    expect(marked.get(first)!.content_disposed_by).toBe(sari.userId);
    expect(marked.get(second)!.content_disposed_at).toBeNull();
    expect(await vaultStat(ctx, db, 'ndt', first)).not.toBe('found');
    expect(await vaultStat(ctx, db, 'ndt', second)).toBe('found');
    const partial = await auditOf(db, 'ndt', packId);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({
      action: 'record.disposed', entity_type: 'evidence_pack', actor_user_id: sari.userId,
      after_data: { contentDisposed: 'partial', completed: false, reviewId: review.id, vaultObjects: [first], failure: 'retention.kept_by_bucket_rule' },
    });

    // Once the bucket allows it, the next approval deletes the rest and completes the disposal.
    const approved = await sari.post<CommandResult>(url(`/reviews/${review.id}/approve`), {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ fileAction: 'vault_content_deleted', vaultObjects: 1 });
    expect((await reviewsOf(db, 'ndt', packId))[0]).toMatchObject({ status: 'disposed', approved_by: sari.userId, file_action: 'vault_content_deleted' });
    expect((await objects()).get(second)!.content_disposed_at).toBeInstanceOf(Date);
    expect(await vaultStat(ctx, db, 'ndt', second)).not.toBe('found');
    const entries = await auditOf(db, 'ndt', packId);
    expect(entries.map((a) => a.action)).toEqual(['record.disposed', 'record.disposed']);
    expect(entries[1]!.after_data).toMatchObject({ contentDisposed: true, reviewId: review.id, fileAction: 'vault_content_deleted', vaultObjects: [second], earlierVaultObjects: [first] });
  });

  it('lists every decision in the disposal register and downloads it as CSV', async () => {
    const page = await sari.get<Page<RetentionRegisterItem>>(url('/register?pageSize=200'));
    expect(page.status).toBe(200);
    const codes = page.body.items.map((r) => `${r.itemCode}:${r.status}`);
    expect(codes).toEqual(expect.arrayContaining(['RET-F-1:kept', 'RET-AE-1:extended', 'RET-DOC-2 v1.0:disposed', 'RET-F-3:disposed', 'RET-DOC-3 v1.0:disposed']));
    expect(page.body.items.every((r) => ['kept', 'extended', 'disposed'].includes(r.status))).toBe(true);
    const doc = page.body.items.find((r) => r.itemCode === 'RET-DOC-2 v1.0')!;
    expect(doc).toMatchObject({ retainMonths: 3, decision: 'dispose', decidedBy: { handle: 'rina' }, approvedBy: { handle: 'sari' }, fileAction: 'vault_content_deleted' });
    expect(page.body.items.find((r) => r.itemCode === 'RET-F-1')).toMatchObject({ retainMonths: 3, keepUntil: '2026-12-31' });
    // Each decision and approval records the period in force then.
    const decided = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'ndt', sql`select after_data from audit_trail where action in ('retention_review.decided', 'retention_review.approved')`);
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every((d) => typeof d.after_data.retainMonths === 'number')).toBe(true);

    const csv = await rina.get(url('/register?format=csv'));
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toBe('text/csv; charset=utf-8');
    expect(String(csv.headers['content-disposition'])).toMatch(/^attachment; filename="disposal-register-ndt-qms-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.raw.toString('utf8').trim().split(/\r\n/);
    expect(lines[0]).toBe('item_code,item_title,record_class,retention_months,retention_ends_on,status,decision,reason,keep_until,decided_by,decided_at,approved_by,approved_at,disposed_at,file_action,file_removed_at');
    expect(lines.length - 1).toBe(page.body.total);
    expect(lines.some((l) => l.startsWith('RET-DOC-3 v1.0,') && l.includes(',owner_asked,'))).toBe(true);
    const downloads = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'ndt', sql`select after_data from audit_trail where action = 'file.downloaded' and entity_type = 'retention_register'`);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.after_data).toMatchObject({ ms: 'qms', format: 'csv' });
    // A later rule change does not rewrite the evidence: decided rows keep the period that applied when they were decided.
    expect((await putRule(rina, 'finding', { retainMonths: 60, basis: 'Raised after the decisions' })).status).toBe(200);
    expect((await putRule(rina, 'document_version', { docType, retainMonths: 60, basis: 'Raised after the decisions' })).status).toBe(200);
    const later = await sari.get<Page<RetentionRegisterItem>>(url('/register?pageSize=200'));
    expect(later.body.items.find((r) => r.itemCode === 'RET-F-1')).toMatchObject({ retainMonths: 3 });
    expect(later.body.items.find((r) => r.itemCode === 'RET-F-3')).toMatchObject({ retainMonths: 3 });
    expect(later.body.items.find((r) => r.itemCode === 'RET-DOC-2 v1.0')).toMatchObject({ retainMonths: 3 });
    const laterCsv = (await rina.get(url('/register?format=csv'))).raw.toString('utf8').trim().split(/\r\n/);
    expect(laterCsv.find((l) => l.startsWith('RET-DOC-2 v1.0,'))!.split(',')[3]).toBe('3');
    // Approvers read the register; a Domain Owner does not.
    expect((await bagus.get(url('/register'))).status).toBe(403);
    expect(await userId(db, 'rina')).toBe(rina.userId);
  });
});
