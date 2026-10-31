// Read confirmation of policies (Milestone 3 D.1, D.2, D.7, J.4, J.5, M3-05) on a copy of the demo template with the
// storage stack of the file tests: the settings of a document on create and update; the request that the approval of
// a new version opens (audience, tasks, notifications, audit) and the close of the earlier version's request; opening
// a version (the provider's address for a person without file rights, the api's redirect for a reader, the content
// route of the Managed Vault and its refusal for a person without file rights there); ACK-OPEN-FIRST; the stored task
// that `tasks.complete` refuses; the register with the person list split of D.7; reminders by the manager; the CSV;
// close and file as evidence; a request by hand; where a request shows; the `acknowledgement.reminders` job
// (reminders, excusals, the overdue digest); and the audit chain after the run.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AcknowledgementRequestDetail, AcknowledgementRequestItem, CommandResult, MyAcknowledgementItem, ObjectOpenResponse,
} from '@mscd/shared';
import { acknowledgementFileGrant } from '../../../src/modules/acknowledgements/acknowledgement-file-grant';
import { AcknowledgementRemindersJob, reminderDateOn, reminderDue } from '../../../src/modules/acknowledgements/acknowledgement-reminders.job';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import {
  auditOf, createAckApp, documentOf, expectedAudience, inOrg, ORG_IDS, peopleOfRequest, rowsOf, signIn, startStorageStack, TODAY, userId,
  verifyChain, versionInReview, type AckApp, type AckClient, type StorageStack,
} from './helpers';

const REQUESTS = (ms: string) => `/api/v1/ms/${ms}/acknowledgement-requests`;
const DOC = (ms: string, id: string) => `/api/v1/ms/${ms}/documents/${id}`;
const SETTINGS = { required: true, scope: 'system_roles', roles: null, dueDays: 14 } as const;

describe('read confirmation of policies (Milestone 3 D.7)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: AckApp;
  let rina: AckClient;
  let bagus: AckClient;
  let hendra: AckClient;
  let maya: AckClient;
  let sari: AckClient;
  let pol14Request: string;

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createAckApp(db, stack.gateway.url);
    rina = await signIn(ctx, db, 'rina', 'ndt');
    bagus = await signIn(ctx, db, 'bagus', 'ndt');
    hendra = await signIn(ctx, db, 'hendra', 'ndt');
    maya = await signIn(ctx, db, 'maya', 'ndt');
    sari = await signIn(ctx, db, 'sari', 'ndt');
  });

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  const mine = async (client: AckClient) => (await client.get<MyAcknowledgementItem[]>('/api/v1/me/acknowledgements')).body;
  const myRow = async (client: AckClient, code: string) => (await mine(client)).find((m) => m.document.code === code && m.status === 'pending');
  const taskOf = async (handle: string, acknowledgementId: string) =>
    (await rowsOf<{ id: string; status: string; title_en: string; due_at: string; ms: string; entity_code: string }>(db, 'ndt', sql`
      select t.id, t.status, t.title_en, t.due_at, m.slug as ms, t.entity_code from task t join platform.app_user u on u.id = t.owner_user_id
        join management_system m on m.id = t.management_system_id
       where u.handle = ${handle} and t.source_rule = 'acknowledgement' and t.entity_type = 'acknowledgement' and t.entity_id = ${acknowledgementId}`))[0];
  const notices = (handle: string, kind: string) =>
    rowsOf<{ id: string; title_en: string; body_en: string; body_id: string; digest: boolean }>(db, 'ndt', sql`
      select n.id, n.title_en, n.body_en, n.body_id, n.digest from notification n join platform.app_user u on u.id = n.recipient_user_id
       where u.handle = ${handle} and n.kind = ${kind} order by n.created_at, n.id`);

  describe('settings of a document (D.2)', () => {
    it('sets read confirmation on update in one audit entry, ignores an unchanged value and refuses a scope without its roles', async () => {
      const doc = await documentOf(db, 'ndt', 'POL-14');
      const set = await rina.patch(DOC('isms', doc.id), { acknowledgement: SETTINGS });
      expect(set.status, set.text).toBe(200);
      const [row] = await rowsOf<{ acknowledgement_required: boolean; acknowledgement_scope: string; acknowledgement_roles: string[] | null; acknowledgement_due_days: number }>(db, 'ndt', sql`
        select acknowledgement_required, acknowledgement_scope, acknowledgement_roles, acknowledgement_due_days from document where id = ${doc.id}`);
      expect(row).toEqual({ acknowledgement_required: true, acknowledgement_scope: 'system_roles', acknowledgement_roles: null, acknowledgement_due_days: 14 });
      const entries = (await auditOf(db, 'ndt', doc.id)).filter((e) => e.action === 'document.updated');
      expect(entries.at(-1)).toMatchObject({
        actor: 'rina',
        before: { acknowledgement: { required: false, scope: 'system_roles', roles: null, dueDays: 14 } },
        after: { acknowledgement: SETTINGS },
      });
      const again = await rina.patch(DOC('isms', doc.id), { acknowledgement: SETTINGS });
      expect(again.status).toBe(200);
      expect((await auditOf(db, 'ndt', doc.id)).filter((e) => e.action === 'document.updated')).toHaveLength(entries.length);
      const invalid = await rina.patch(DOC('isms', doc.id), { acknowledgement: { required: true, scope: 'roles', roles: null, dueDays: 14 } });
      expect(invalid.status).toBe(400);
      // Only the Management System Manager changes it (`document.manage`).
      expect((await bagus.patch(DOC('isms', doc.id), { acknowledgement: SETTINGS })).status).toBe(403);
    });

    it('stores the settings of a new document and names them in its audit entry', async () => {
      const created = await rina.post('/api/v1/ms/isms/documents', {
        docCode: 'POL-31', title: 'Clear Desk Policy', docType: 'policy', ownerHandle: 'andi', classification: 'internal', orgWide: false, linkedMs: ['isms'],
        acknowledgement: { required: true, scope: 'roles', roles: ['domain_owner'], dueDays: 21 },
      }, { 'idempotency-key': 'ack-doc-create-1' });
      expect(created.status, created.text).toBe(201);
      const [row] = await rowsOf<{ acknowledgement_required: boolean; acknowledgement_scope: string; acknowledgement_roles: string[]; acknowledgement_due_days: number }>(db, 'ndt', sql`
        select acknowledgement_required, acknowledgement_scope, acknowledgement_roles, acknowledgement_due_days from document where doc_code = 'POL-31'`);
      expect(row).toEqual({ acknowledgement_required: true, acknowledgement_scope: 'roles', acknowledgement_roles: ['domain_owner'], acknowledgement_due_days: 21 });
      expect((await auditOf(db, 'ndt', created.body.ref.id))[0]!.after).toMatchObject({ acknowledgement: { required: true, scope: 'roles', roles: ['domain_owner'], dueDays: 21 } });
    });
  });

  describe('a request opened by approval (D.2, D.7 "Request")', () => {
    it('asks every person with a role in the document\'s systems, with a task and a notification each, and audits the request', async () => {
      const doc = await documentOf(db, 'ndt', 'POL-14');
      await versionInReview(db, 'ndt', 'POL-14', '2.0', 'andi');
      const approved = await rina.post(`${DOC('isms', doc.id)}/transitions`, { to: 'approved' });
      expect(approved.status, approved.text).toBe(200);
      expect(CommandResult.safeParse(approved.body).success).toBe(true);
      const [request] = await rowsOf<{ id: string; status: string; audience_scope: string; audience_count: number; due_on: string; ms: string; version: string }>(db, 'ndt', sql`
        select r.id, r.status, r.audience_scope, r.audience_count, r.due_on, m.slug as ms, v.version_label as version
          from acknowledgement_request r join management_system m on m.id = r.management_system_id join document_version v on v.id = r.document_version_id
         where r.document_id = ${doc.id}`);
      pol14Request = request!.id;
      expect(request).toMatchObject({ status: 'open', audience_scope: 'system_roles', due_on: '2026-10-13', ms: 'isms', version: '2.0' });
      const audience = await expectedAudience(db, 'ndt', ['isms']);
      expect(audience).toEqual(expect.arrayContaining(['bagus', 'hendra', 'maya', 'rina']));
      expect(audience).not.toContain('ext.auditor');
      const people = await peopleOfRequest(db, 'ndt', pol14Request);
      expect(people.map((p) => p.handle)).toEqual(audience);
      expect(people.every((p) => p.status === 'pending')).toBe(true);
      expect(request!.audience_count).toBe(audience.length);
      expect(approved.body.message[0]).toBe(`POL-14 v2.0 approved. ${audience.length} people are asked to confirm that they have read it.`);

      const bagusRow = await myRow(bagus, 'POL-14');
      expect(bagusRow).toMatchObject({ ms: 'isms', versionLabel: '2.0', status: 'pending', dueOn: '2026-10-13', openedAt: null, overdue: false });
      expect(await taskOf('bagus', bagusRow!.id)).toMatchObject({
        status: 'open', due_at: '2026-10-13', ms: 'isms', entity_code: 'POL-14',
        title_en: expect.stringMatching(/^Read and confirm POL-14 .+, version 2\.0, in Policies to confirm$/),
      });
      const sent = await notices('bagus', 'acknowledgement_requested');
      expect(sent.at(-1)).toMatchObject({ title_en: 'Please read and confirm POL-14', digest: false, body_en: expect.stringContaining('by 13 Oct 2026') });
      expect(sent.at(-1)!.body_id).toContain('13 Okt 2026');
      expect((await auditOf(db, 'ndt', pol14Request))[0]).toMatchObject({
        action: 'acknowledgement_request.created',
        actor: 'rina',
        after: { document: 'POL-14', version: '2.0', audience_scope: 'system_roles', audience: audience.length, due_on: '2026-10-13' },
      });
    });

    it('opens no request when the document does not ask for read confirmation', async () => {
      const doc = await documentOf(db, 'ndt', 'PRC-08');
      await versionInReview(db, 'ndt', 'PRC-08', '1.4', 'andi');
      expect((await rina.post(`${DOC('isms', doc.id)}/transitions`, { to: 'approved' })).status).toBe(200);
      expect(await rowsOf(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${doc.id}`)).toEqual([]);
    });
  });

  describe('confirming (D.7 "Confirming", H.7)', () => {
    it('refuses to confirm before the version is opened (ACK-OPEN-FIRST), and tasks.complete refuses the task', async () => {
      const row = await myRow(bagus, 'POL-14');
      const early = await bagus.post(`/api/v1/me/acknowledgements/${row!.id}/confirm`);
      expect(early.status).toBe(422);
      expect(early.body).toMatchObject({ rule: 'ACK-OPEN-FIRST', messageKey: 'rule.ACK-OPEN-FIRST' });
      expect(early.body.messages.en).toBe('Open POL-14 first. You can confirm it only after you have opened the version you are asked to read.');
      const task = await taskOf('bagus', row!.id);
      const marked = await bagus.post(`/api/v1/tasks/${task!.id}/complete`);
      expect(marked.status).toBe(422);
      expect(marked.body).toMatchObject({ messageKey: 'task_completes_on_screen' });
      expect(marked.body.messages.en).toContain('Policies to confirm');
      expect((await taskOf('bagus', row!.id))!.status).toBe('open');
      // Another person's row is not there for the caller.
      expect((await hendra.post(`/api/v1/me/acknowledgements/${row!.id}/open`)).status).toBe(404);
      expect((await hendra.post(`/api/v1/me/acknowledgements/${row!.id}/confirm`)).status).toBe(404);
    });

    it('gives a person without file rights the provider\'s address, records the first open, and then takes the confirmation', async () => {
      const row = await myRow(bagus, 'POL-14');
      const opened = await bagus.post<ObjectOpenResponse>(`/api/v1/me/acknowledgements/${row!.id}/open`);
      expect(opened.status, opened.text).toBe(200);
      expect(ObjectOpenResponse.safeParse(opened.body).success).toBe(true);
      expect(opened.body.url).toMatch(/^https?:\/\//);
      expect(opened.body.url).not.toContain('/api/v1/');
      const [first] = await peopleOfRequest(db, 'ndt', pol14Request).then((list) => list.filter((p) => p.handle === 'bagus'));
      expect(first!.opened_at).not.toBeNull();
      const audit = await auditOf(db, 'ndt', row!.id);
      expect(audit.map((a) => a.action)).toEqual(['acknowledgement.opened']);
      expect(audit[0]).toMatchObject({ actor: 'bagus', after: { document: 'POL-14', version: '2.0', via: 'provider', first: true } });
      const objectId = (await documentOf(db, 'ndt', 'POL-14')).objectId!;
      expect((await auditOf(db, 'ndt', objectId)).at(-1)).toMatchObject({ action: 'file.opened', actor: 'bagus', after: { via: 'acknowledgement' } });

      const confirmed = await bagus.post(`/api/v1/me/acknowledgements/${row!.id}/confirm`);
      expect(confirmed.status, confirmed.text).toBe(200);
      expect(confirmed.body.message[0]).toBe('You confirmed POL-14 version 2.0');
      expect((await taskOf('bagus', row!.id))!.status).toBe('done');
      expect((await auditOf(db, 'ndt', row!.id)).at(-1)).toMatchObject({ action: 'acknowledgement.confirmed', actor: 'bagus', after: { status: 'confirmed' } });
      expect((await bagus.post(`/api/v1/me/acknowledgements/${row!.id}/confirm`)).status).toBe(409);
      const done = (await mine(bagus)).find((m) => m.id === row!.id);
      expect(done).toMatchObject({ status: 'confirmed', confirmedAt: expect.any(String) });
      // Opening again is allowed and keeps the first time.
      expect((await bagus.post(`/api/v1/me/acknowledgements/${row!.id}/open`)).status).toBe(200);
      const [again] = (await peopleOfRequest(db, 'ndt', pol14Request)).filter((p) => p.handle === 'bagus');
      expect(again!.opened_at).toEqual(first!.opened_at);
    });

    it('gives a reader the api\'s redirect, which sends the browser to the provider', async () => {
      const row = await myRow(rina, 'POL-14');
      const opened = await rina.post<ObjectOpenResponse>(`/api/v1/me/acknowledgements/${row!.id}/open`);
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.url).toMatch(/^\/api\/v1\/storage\/objects\/[0-9a-f-]{36}\/redirect\?t=/);
      const redirected = await rina.get(opened.body.url);
      expect(redirected.status).toBe(302);
      expect(String(redirected.headers.location)).toMatch(/^https?:\/\//);
      // Top Management has no file rights: the provider's address, where the person's own access applies.
      const hendraRow = await myRow(hendra, 'POL-14');
      const top = await hendra.post<ObjectOpenResponse>(`/api/v1/me/acknowledgements/${hendraRow!.id}/open`);
      expect(top.status, top.text).toBe(200);
      expect(top.body.url).not.toContain('/api/v1/');
    });
  });

  describe('the register (D.7 "Register")', () => {
    it('lists requests with totals for managers and Top Management, and refuses Internal Auditors', async () => {
      const list = await rina.get<AcknowledgementRequestItem[]>(REQUESTS('isms'));
      expect(list.status).toBe(200);
      const item = list.body.find((r) => r.id === pol14Request)!;
      expect(AcknowledgementRequestItem.safeParse(item).success).toBe(true);
      const audience = (await expectedAudience(db, 'ndt', ['isms'])).length;
      expect(item).toMatchObject({ ms: 'isms', document: { code: 'POL-14' }, version: { label: '2.0' }, status: 'open', dueOn: '2026-10-13' });
      expect(item.totals).toEqual({ audience, confirmed: 1, pending: audience - 1, overdue: 0, excused: 0 });
      expect((await hendra.get(REQUESTS('isms'))).status).toBe(200);
      expect((await maya.get(REQUESTS('isms'))).status).toBe(403);
      expect((await bagus.get(REQUESTS('isms'))).status).toBe(403);
    });

    it('shows the person list with audit.pending.all and totals only to Top Management (product decisions 2 and 3)', async () => {
      const full = await rina.get<AcknowledgementRequestDetail>(`${REQUESTS('isms')}/${pol14Request}`);
      expect(full.status).toBe(200);
      expect(AcknowledgementRequestDetail.safeParse(full.body).success).toBe(true);
      const bagusLine = full.body.people!.find((p) => p.person.handle === 'bagus');
      expect(bagusLine).toMatchObject({ person: { displayName: 'Bagus Prasetyo' }, status: 'confirmed', openedAt: expect.any(String), confirmedAt: expect.any(String), overdue: false });
      const totals = await hendra.get<AcknowledgementRequestDetail>(`${REQUESTS('isms')}/${pol14Request}`);
      expect(totals.status).toBe(200);
      expect(totals.body.people).toBeUndefined();
      expect(totals.body.totals.confirmed).toBe(1);
      expect((await maya.get(`${REQUESTS('isms')}/${pol14Request}`)).status).toBe(403);
      expect((await rina.get(`${REQUESTS('isms')}/00000000-0000-4000-8000-000000000999`)).status).toBe(404);
    });

    it('reminds the pending people once a day and audits it', async () => {
      const before = (await notices('maya', 'acknowledgement_requested')).length;
      const reminded = await rina.post(`${REQUESTS('isms')}/${pol14Request}/remind`);
      expect(reminded.status, reminded.text).toBe(200);
      const audience = (await expectedAudience(db, 'ndt', ['isms'])).length;
      expect(reminded.body.count).toBe(audience - 1);
      const after = await notices('maya', 'acknowledgement_requested');
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)!.title_en).toBe('Reminder: confirm that you have read POL-14');
      const people = await peopleOfRequest(db, 'ndt', pol14Request);
      expect(people.find((p) => p.handle === 'maya')!.reminder_count).toBe(1);
      expect(people.find((p) => p.handle === 'bagus')!.reminder_count).toBe(0);
      expect((await auditOf(db, 'ndt', pol14Request)).at(-1)).toMatchObject({ action: 'acknowledgement_request.reminded', actor: 'rina', after: { reminded: audience - 1, source: 'manager' } });
      const twice = await rina.post(`${REQUESTS('isms')}/${pol14Request}/remind`);
      expect(twice.status).toBe(409);
      expect(twice.body.messageKey).toBe('acknowledgements.reminded_today');
      expect((await hendra.post(`${REQUESTS('isms')}/${pol14Request}/remind`)).status).toBe(403);
    });

    it('downloads the register as formula-safe CSV with audit.pending.all only', async () => {
      const csv = await rina.get(`${REQUESTS('isms')}/${pol14Request}/export`);
      expect(csv.status).toBe(200);
      expect(String(csv.headers['content-type'])).toContain('text/csv');
      expect(String(csv.headers['content-disposition'])).toContain('read-confirmations-POL-14-v2.0-2026-09-29.csv');
      const lines = csv.text.trim().split(/\r\n/);
      expect(lines[0]).toBe('Document,Title,Version,Due date,User name,Name,Status,Opened at,Confirmed at,Reminders,Overdue,Excused reason');
      expect(lines.find((l) => l.includes(',bagus,'))).toMatch(/^POL-14,.+,2\.0,2026-10-13,bagus,Bagus Prasetyo,confirmed,\d{4}-.+,\d{4}-.+,0,no,$/);
      expect(lines).toHaveLength((await expectedAudience(db, 'ndt', ['isms'])).length + 1);
      expect((await hendra.get(`${REQUESTS('isms')}/${pol14Request}/export`)).status).toBe(403);
    });
  });

  describe('a request by hand (acknowledgement-requests.create)', () => {
    it('asks the chosen roles for the current approved version; 409 for a version with an open request; 422 for a draft', async () => {
      const pol01 = await documentOf(db, 'ndt', 'POL-01');
      const created = await rina.post(REQUESTS('isms'), { documentId: pol01.id, audience: { scope: 'roles', roles: ['top_management'] }, dueDays: 7 });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ changed: ['isms'], data: { audience: 1, dueOn: '2026-10-06', replaced: 0 }, ref: { entityType: 'acknowledgement_request', code: 'POL-01' } });
      expect((await peopleOfRequest(db, 'ndt', created.body.data.id)).map((p) => p.handle)).toEqual(await expectedAudience(db, 'ndt', ['isms'], ['top_management']));
      const twice = await rina.post(REQUESTS('isms'), { documentId: pol01.id });
      expect(twice.status).toBe(409);
      expect(twice.body.messageKey).toBe('acknowledgements.open_request');
      const draft = await documentOf(db, 'ndt', 'PRC-16');
      const refused = await rina.post(REQUESTS('isms'), { documentId: draft.id });
      expect(refused.status).toBe(422);
      expect(refused.body.messageKey).toBe('acknowledgements.not_approved');
      // A document of another system is not found through this one; Top Management may not ask.
      const qm01 = await documentOf(db, 'ndt', 'QM-01');
      expect((await rina.post(REQUESTS('isms'), { documentId: qm01.id })).status).toBe(404);
      expect((await hendra.post(REQUESTS('isms'), { documentId: pol01.id })).status).toBe(403);
    });
  });

  describe('a new version replaces the open request (D.7 "Request")', () => {
    it('closes the earlier request, excuses its pending people and cancels their tasks; confirmations stay', async () => {
      const doc = await documentOf(db, 'ndt', 'POL-14');
      const mayaRow = await myRow(maya, 'POL-14');
      await versionInReview(db, 'ndt', 'POL-14', '2.1', 'andi');
      expect((await rina.post(`${DOC('isms', doc.id)}/transitions`, { to: 'approved' })).status).toBe(200);
      const [earlier] = await rowsOf<{ status: string; closed_at: Date | null }>(db, 'ndt', sql`select status, closed_at from acknowledgement_request where id = ${pol14Request}`);
      expect(earlier).toMatchObject({ status: 'closed', closed_at: expect.any(Date) });
      const people = await peopleOfRequest(db, 'ndt', pol14Request);
      expect(people.find((p) => p.handle === 'bagus')).toMatchObject({ status: 'confirmed', excused_reason: null });
      expect(people.find((p) => p.handle === 'maya')).toMatchObject({ status: 'excused', excused_reason: 'Replaced by version 2.1' });
      expect((await taskOf('maya', mayaRow!.id))!.status).toBe('cancelled');
      expect((await auditOf(db, 'ndt', pol14Request)).at(-1)).toMatchObject({ action: 'acknowledgement_request.closed', actor: 'rina', after: { replaced_by: '2.1' } });
      const newer = await myRow(maya, 'POL-14');
      expect(newer).toMatchObject({ versionLabel: '2.1', status: 'pending' });
      // The excused row is listed as excused; opening it is refused.
      expect((await mine(maya)).find((m) => m.id === mayaRow!.id)).toMatchObject({ status: 'excused' });
      expect((await maya.post(`/api/v1/me/acknowledgements/${mayaRow!.id}/open`)).body.messageKey).toBe('acknowledgements.excused');
    });
  });

  describe('Managed Vault, close and file as evidence', () => {
    let qmRequest: string;

    it('opens a vault version through the content route for a reader and refuses a person without file rights there', async () => {
      const doc = await documentOf(db, 'ndt', 'QM-01');
      const [repo] = await rowsOf<{ adapter: string }>(db, 'ndt', sql`
        select r.adapter from storage_object o join storage_repository r on r.id = o.storage_repository_id where o.id = ${doc.objectId}`);
      expect(repo!.adapter).toBe('managed_vault');
      await rina.patch(DOC('qms', doc.id), { acknowledgement: SETTINGS });
      await versionInReview(db, 'ndt', 'QM-01', '5.1', 'yusuf');
      expect((await rina.post(`${DOC('qms', doc.id)}/transitions`, { to: 'approved' })).status).toBe(200);
      const opened0 = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${doc.id} and status = 'open'`);
      qmRequest = opened0[0]!.id;
      const sariRow = await myRow(sari, 'QM-01');
      expect(sariRow!.ms).toBe('qms');
      const opened = await sari.post<ObjectOpenResponse>(`/api/v1/me/acknowledgements/${sariRow!.id}/open`);
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.url).toBe(`/api/v1/storage/objects/${doc.objectId}/content?ms=qms&inline=true`);
      const bagusRow = await myRow(bagus, 'QM-01');
      const refused = await bagus.post(`/api/v1/me/acknowledgements/${bagusRow!.id}/open`);
      expect(refused.status).toBe(422);
      expect(refused.body.messageKey).toBe('acknowledgements.file_not_readable');
      expect((await peopleOfRequest(db, 'ndt', qmRequest)).find((p) => p.handle === 'bagus')!.opened_at).toBeNull();
      // The check a redirect token naming the row asks (follow-up 1 of the handoff): bagus's own row grants the
      // version's file; another person, another file or an unknown row grants nothing.
      const pol01 = await documentOf(db, 'ndt', 'POL-01');
      const grants = await inOrg(db, 'ndt', async (trx) => ({
        own: await acknowledgementFileGrant(trx, bagus.userId, bagusRow!.id, doc.objectId!),
        otherPerson: await acknowledgementFileGrant(trx, sari.userId, bagusRow!.id, doc.objectId!),
        otherFile: await acknowledgementFileGrant(trx, bagus.userId, bagusRow!.id, pol01.objectId!),
        unknown: await acknowledgementFileGrant(trx, bagus.userId, '00000000-0000-4000-8000-000000000000', doc.objectId!),
      }));
      expect(grants.own).toMatchObject({ acknowledgementId: bagusRow!.id, documentCode: 'QM-01', versionLabel: '5.1' });
      expect(grants).toMatchObject({ otherPerson: null, otherFile: null, unknown: null });
    });

    it('closes the request into an evidence item: a new current file holds the register, reminders stop', async () => {
      const [evidence] = await rowsOf<{ id: string; evidence_code: string; storage_object_id: string | null }>(db, 'ndt', sql`
        select e.id, e.evidence_code, e.storage_object_id from evidence e
         where e.deleted_at is null and exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id
           and l.management_system_id = (select id from management_system where slug = 'qms') and l.deleted_at is null)
           and not exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id
           and l.management_system_id <> (select id from management_system where slug = 'qms') and l.deleted_at is null)
         order by e.evidence_code limit 1`);
      const pendingBefore = (await peopleOfRequest(db, 'ndt', qmRequest)).filter((p) => p.status === 'pending').length;
      const closed = await rina.post(`${REQUESTS('qms')}/${qmRequest}/close`, { evidenceId: evidence!.id });
      expect(closed.status, closed.text).toBe(200);
      expect(closed.body).toMatchObject({ data: { evidenceCode: evidence!.evidence_code } });
      expect(closed.body.changed).toContain('qms');
      const [after] = await rowsOf<{ storage_object_id: string }>(db, 'ndt', sql`select storage_object_id from evidence where id = ${evidence!.id}`);
      expect(after!.storage_object_id).toBe(closed.body.data.storageObjectId);
      expect(after!.storage_object_id).not.toBe(evidence!.storage_object_id);
      const content = await rina.get(`/api/v1/storage/objects/${after!.storage_object_id}/content?ms=qms`);
      expect(content.status).toBe(200);
      expect(content.text.split(/\r\n/)[0]).toBe('Document,Title,Version,Due date,User name,Name,Status,Opened at,Confirmed at,Reminders,Overdue,Excused reason');
      expect(content.text).toContain('QM-01');
      const [request] = await rowsOf<{ status: string; evidence_id: string }>(db, 'ndt', sql`select status, evidence_id from acknowledgement_request where id = ${qmRequest}`);
      expect(request).toEqual({ status: 'closed', evidence_id: evidence!.id });
      const open = await rowsOf(db, 'ndt', sql`select t.id from task t join acknowledgement a on a.id = t.entity_id
        where a.acknowledgement_request_id = ${qmRequest} and t.source_rule = 'acknowledgement' and t.status = 'open'`);
      expect(open).toEqual([]);
      expect((await peopleOfRequest(db, 'ndt', qmRequest)).filter((p) => p.status === 'pending')).toHaveLength(pendingBefore);
      expect((await auditOf(db, 'ndt', qmRequest)).at(-1)).toMatchObject({ action: 'acknowledgement_request.closed', after: { evidence: evidence!.evidence_code } });
      const fileAudit = (await auditOf(db, 'ndt', evidence!.id)).at(-1);
      expect(fileAudit).toMatchObject({ action: 'evidence.file_uploaded', after: { source: 'generated' } });
      expect((await rina.post(`${REQUESTS('qms')}/${qmRequest}/close`, {})).status).toBe(409);
      expect((await rina.post(`${REQUESTS('qms')}/${qmRequest}/remind`)).body.messageKey).toBe('acknowledgements.request_closed');
      // A pending person of a closed request can no longer confirm, and the row leaves their list.
      const bagusLeft = await rowsOf<{ id: string }>(db, 'ndt', sql`select a.id from acknowledgement a join platform.app_user u on u.id = a.user_id
        where a.acknowledgement_request_id = ${qmRequest} and u.handle = 'bagus'`);
      expect((await bagus.post(`/api/v1/me/acknowledgements/${bagusLeft[0]!.id}/confirm`)).body.messageKey).toBe('acknowledgements.request_closed');
      expect((await mine(bagus)).some((m) => m.id === bagusLeft[0]!.id)).toBe(false);
      const qm01 = await documentOf(db, 'ndt', 'QM-01');
      expect(await inOrg(db, 'ndt', (trx) => acknowledgementFileGrant(trx, bagus.userId, bagusLeft[0]!.id, qm01.objectId!))).toBeNull();
    });

    it('refuses an evidence item of another system without closing the request', async () => {
      const doc = await documentOf(db, 'ndt', 'POL-01');
      const [request] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${doc.id} and status = 'open'`);
      const [qmsEvidence] = await rowsOf<{ id: string }>(db, 'ndt', sql`select e.id from evidence e where e.deleted_at is null
        and not exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = e.id
          and l.management_system_id = (select id from management_system where slug = 'isms') and l.deleted_at is null)
        and not exists (select 1 from evidence_target t where t.evidence_id = e.id and t.management_system_id = (select id from management_system where slug = 'isms'))
        limit 1`);
      const refused = await rina.post(`${REQUESTS('isms')}/${request!.id}/close`, { evidenceId: qmsEvidence!.id });
      expect(refused.status).toBe(404);
      const [still] = await rowsOf<{ status: string }>(db, 'ndt', sql`select status from acknowledgement_request where id = ${request!.id}`);
      expect(still!.status).toBe('open');
    });
  });

  describe('where a request shows (D.7)', () => {
    it('shows a request of a shared document in every system it is linked to, and a request of one system only there', async () => {
      const ims = await documentOf(db, 'ndt', 'IMS-01');
      const created = await rina.post(REQUESTS('qms'), { documentId: ims.id, audience: { scope: 'roles', roles: ['top_management'] } });
      expect(created.status, created.text).toBe(201);
      const id = created.body.data.id as string;
      const [primary] = await rowsOf<{ slug: string }>(db, 'ndt', sql`select m.slug from acknowledgement_request r join management_system m on m.id = r.management_system_id where r.id = ${id}`);
      for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
        expect((await rina.get(`${REQUESTS(ms)}/${id}`)).status, `${ms} (primary ${primary!.slug})`).toBe(200);
        expect((await rina.get<AcknowledgementRequestItem[]>(REQUESTS(ms))).body.some((r) => r.id === id)).toBe(true);
      }
      const pol01 = await documentOf(db, 'ndt', 'POL-01');
      const [isms] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${pol01.id} and status = 'open'`);
      expect((await rina.get(`${REQUESTS('qms')}/${isms!.id}`)).status).toBe(404);
      expect((await rina.get<AcknowledgementRequestItem[]>(REQUESTS('qms'))).body.some((r) => r.id === isms!.id)).toBe(false);
      // A request whose system is not the document's primary one shows only in its own system.
      const [version] = await rowsOf<{ id: string }>(db, 'ndt', sql`select current_version_id as id from document where id = ${ims.id}`);
      const [stray] = await rowsOf<{ id: string }>(db, 'ndt', sql`insert into acknowledgement_request (management_system_id, document_id, document_version_id, audience_scope, due_on, status, closed_at)
        values ((select id from management_system where slug = ${primary!.slug === 'qms' ? 'bcms' : 'qms'}), ${ims.id}, ${version!.id}, 'organisation', '2026-10-13', 'closed', now()) returning id`);
      expect((await rina.get(`${REQUESTS(primary!.slug)}/${stray!.id}`)).status).toBe(404);
    });

    it('shows a request of an organisation-wide document in every system, and takes a request by hand from a system it is not linked to', async () => {
      // An approved ISMS document linked to the ISMS only, made organisation-wide: the snapshot lists it in every system.
      const [doc] = await rowsOf<{ id: string; doc_code: string }>(db, 'ndt', sql`
        select d.id, d.doc_code from document d
         where d.deleted_at is null and d.status = 'approved' and d.current_version_id is not null and not d.is_org_wide
           and d.doc_code not in ('POL-01', 'POL-14', 'POL-31')
           and not exists (select 1 from acknowledgement_request r where r.document_id = d.id)
           and (select array_agg(m.slug::text) from entity_ms_link l join management_system m on m.id = l.management_system_id
                 where l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null) = array['isms']::text[]
         order by d.doc_code limit 1`);
      expect(doc, 'an approved document of the ISMS only').toBeTruthy();
      await rowsOf(db, 'ndt', sql`update document set is_org_wide = true where id = ${doc!.id} returning id`);
      try {
        const created = await rina.post(REQUESTS('bcms'), { documentId: doc!.id, audience: { scope: 'roles', roles: ['top_management'] } });
        expect(created.status, created.text).toBe(201);
        const id = created.body.data.id as string;
        const [request] = await rowsOf<{ slug: string; audience_count: number }>(db, 'ndt', sql`
          select m.slug, r.audience_count from acknowledgement_request r join management_system m on m.id = r.management_system_id where r.id = ${id}`);
        // The request belongs to the document's primary system; its audience is the Top Management of every system.
        expect(request!.slug).toBe('isms');
        expect((await peopleOfRequest(db, 'ndt', id)).map((p) => p.handle)).toEqual(await expectedAudience(db, 'ndt', ['isms', 'qms', 'bcms', 'abms'], ['top_management']));
        for (const ms of ['isms', 'qms', 'bcms', 'abms']) {
          expect((await rina.get(`${REQUESTS(ms)}/${id}`)).status, ms).toBe(200);
          expect((await rina.get<AcknowledgementRequestItem[]>(REQUESTS(ms))).body.some((r) => r.id === id), ms).toBe(true);
          expect((await hendra.get<AcknowledgementRequestItem[]>(REQUESTS(ms))).body.some((r) => r.id === id), `hendra ${ms}`).toBe(true);
        }
      } finally {
        await rowsOf(db, 'ndt', sql`update document set is_org_wide = false where id = ${doc!.id} returning id`);
      }
      // Back to the ISMS only: the request shows there and no longer in the other systems; a request by hand from them is 404.
      const [request] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${doc!.id} and status = 'open'`);
      expect((await rina.get(`${REQUESTS('isms')}/${request!.id}`)).status).toBe(200);
      expect((await rina.get(`${REQUESTS('bcms')}/${request!.id}`)).status).toBe(404);
      expect((await rina.post(REQUESTS('bcms'), { documentId: doc!.id })).status).toBe(404);
    });
  });

  describe('the daily job acknowledgement.reminders (D.7 "Reminders", J.3)', () => {
    it('computes the reminder dates: 7 days after the start, the due date, then every 7 days, at most three times', () => {
      expect(reminderDateOn('2026-09-01', '2026-09-15', '2026-09-07')).toBeNull();
      expect(reminderDateOn('2026-09-01', '2026-09-15', '2026-09-08')).toBe('2026-09-08');
      expect(reminderDateOn('2026-09-01', '2026-09-15', '2026-09-15')).toBe('2026-09-15');
      expect(reminderDateOn('2026-09-01', '2026-09-15', '2026-09-21')).toBe('2026-09-15');
      expect(reminderDateOn('2026-09-01', '2026-09-15', '2026-09-22')).toBe('2026-09-22');
      // A due date within 7 days has no early reminder.
      expect(reminderDateOn('2026-09-01', '2026-09-05', '2026-09-04')).toBeNull();
      expect(reminderDue({ startedOn: '2026-09-01', dueOn: '2026-09-15', today: '2026-09-10', lastRemindedOn: null, count: 0 })).toBe(true);
      expect(reminderDue({ startedOn: '2026-09-01', dueOn: '2026-09-15', today: '2026-09-10', lastRemindedOn: '2026-09-08', count: 1 })).toBe(false);
      expect(reminderDue({ startedOn: '2026-09-01', dueOn: '2026-09-15', today: '2026-09-15', lastRemindedOn: '2026-09-08', count: 1 })).toBe(true);
      expect(reminderDue({ startedOn: '2026-09-01', dueOn: '2026-09-15', today: '2026-09-29', lastRemindedOn: '2026-09-15', count: 3 })).toBe(false);
    });

    it('reminds on the dates, excuses people who left the audience or the organisation, and tells the managers once when overdue', async () => {
      const job = ctx.moduleRef.get(AcknowledgementRemindersJob);
      const pol31 = await documentOf(db, 'ndt', 'POL-31');
      await versionInReview(db, 'ndt', 'POL-31', '1.0', 'andi', 'POL-14');
      expect((await rina.post(`${DOC('isms', pol31.id)}/transitions`, { to: 'approved' })).status).toBe(200);
      const [request] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from acknowledgement_request where document_id = ${pol31.id} and status = 'open'`);
      const id = request!.id;
      const domainOwners = await expectedAudience(db, 'ndt', ['isms'], ['domain_owner']);
      expect((await peopleOfRequest(db, 'ndt', id)).map((p) => p.handle)).toEqual(domainOwners);
      expect(domainOwners).toEqual(expect.arrayContaining(['bagus', 'dewi', 'fajar']));
      // Started 7 days ago, due in 7 days: the early reminder is due today.
      await rowsOf(db, 'ndt', sql`update acknowledgement_request set created_at = '2026-09-22T03:00:00Z', due_on = '2026-10-06' where id = ${id} returning id`);
      const first = await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect(first!.reminded).toBeGreaterThanOrEqual(domainOwners.length);
      expect((await peopleOfRequest(db, 'ndt', id)).every((p) => p.reminder_count === 1)).toBe(true);
      expect((await auditOf(db, 'ndt', id)).at(-1)).toMatchObject({ action: 'acknowledgement_request.reminded', after: { source: 'schedule', date: TODAY } });
      // The same day again: nobody twice.
      await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect((await peopleOfRequest(db, 'ndt', id)).every((p) => p.reminder_count === 1)).toBe(true);
      // The due date: the second reminder; after the third, none.
      await rowsOf(db, 'ndt', sql`update acknowledgement set reminded_at = '2026-09-22T03:00:00Z' where acknowledgement_request_id = ${id} returning id`);
      await rowsOf(db, 'ndt', sql`update acknowledgement_request set due_on = ${TODAY} where id = ${id} returning id`);
      await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect((await peopleOfRequest(db, 'ndt', id)).every((p) => p.reminder_count === 2)).toBe(true);
      await rowsOf(db, 'ndt', sql`update acknowledgement set reminded_at = '2026-09-22T03:00:00Z', reminder_count = 3 where acknowledgement_request_id = ${id} returning id`);
      await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect((await peopleOfRequest(db, 'ndt', id)).every((p) => p.reminder_count === 3)).toBe(true);

      // dewi loses her ISMS role, fajar's membership ends: both are excused with the reason; their tasks are cancelled.
      const dewi = await userId(db, 'dewi');
      const fajar = await userId(db, 'fajar');
      await rowsOf(db, 'ndt', sql`update user_ms_role set deleted_at = now() where user_id = ${dewi} and management_system_id = (select id from management_system where slug = 'isms') returning id`);
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        sql`update platform.org_membership set status = 'disabled' where user_id = ${fajar} and organization_id = ${ORG_IDS.ndt}`.execute(trx));
      try {
        const excused = await job.run(ORG_IDS.ndt, undefined, TODAY);
        expect(excused!.excused).toBeGreaterThanOrEqual(2);
        const people = await peopleOfRequest(db, 'ndt', id);
        expect(people.find((p) => p.handle === 'dewi')).toMatchObject({ status: 'excused', excused_reason: 'No longer holds a role that is asked to confirm' });
        expect(people.find((p) => p.handle === 'fajar')).toMatchObject({ status: 'excused', excused_reason: 'Membership of the organisation ended' });
        const cancelled = await rowsOf<{ status: string }>(db, 'ndt', sql`select t.status from task t join acknowledgement a on a.id = t.entity_id
          where a.acknowledgement_request_id = ${id} and a.user_id = ${dewi} and t.source_rule = 'acknowledgement'`);
        expect(cancelled).toEqual([{ status: 'cancelled' }]);
      } finally {
        await inScope(db.migrator, { platformScope: true }, (trx) =>
          sql`update platform.org_membership set status = 'active' where user_id = ${fajar} and organization_id = ${ORG_IDS.ndt}`.execute(trx));
      }

      // Overdue: the system's Management System Managers get one digest notice per request.
      await rowsOf(db, 'ndt', sql`update acknowledgement_request set due_on = '2026-09-20' where id = ${id} returning id`);
      const overdue = await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect(overdue!.overdueNotices).toBeGreaterThanOrEqual(1);
      const digest = (await notices('rina', 'acknowledgement_overdue')).filter((n) => n.title_en === 'Read confirmation of POL-31 is overdue');
      expect(digest).toHaveLength(1);
      expect(digest[0]).toMatchObject({ digest: true, body_en: expect.stringContaining('due on 20 Sep 2026') });
      await job.run(ORG_IDS.ndt, undefined, TODAY);
      expect((await notices('rina', 'acknowledgement_overdue')).filter((n) => n.title_en === 'Read confirmation of POL-31 is overdue')).toHaveLength(1);
      // The register counts the overdue people.
      const item = (await rina.get<AcknowledgementRequestItem[]>(REQUESTS('isms'))).body.find((r) => r.id === id)!;
      expect(item.totals.overdue).toBe(item.totals.pending);
      expect(item.totals.overdue).toBeGreaterThan(0);
    });
  });

  describe('tasks.complete and the other screen-completed sources (D.2)', () => {
    it('refuses tasks of an access review and a personal data check too', async () => {
      const bagusId = await userId(db, 'bagus');
      for (const source of ['access_review', 'privacy_check'] as const) {
        const [task] = await inOrg(db, 'ndt', async (trx) => (await sql<{ id: string }>`
          insert into task (management_system_id, source_rule, entity_type, entity_id, title_en, title_id, owner_user_id, status)
          values ((select id from management_system where slug = 'isms'), ${source}, ${source === 'access_review' ? 'access_review_part' : 'privacy_check'},
                  gen_random_uuid(), 'Check', 'Periksa', ${bagusId}, 'open') returning id`.execute(trx)).rows);
        const refused = await bagus.post(`/api/v1/tasks/${task!.id}/complete`);
        expect(refused.status).toBe(422);
        expect(refused.body.messageKey).toBe('task_completes_on_screen');
        expect(refused.body.messages.en).toContain(source === 'access_review' ? 'Access review of this system' : 'Personal data checks');
      }
    });
  });

  it('leaves a verifiable audit chain', async () => {
    const chain = await verifyChain(db, 'ndt');
    expect(chain.firstBroken).toBeNull();
  });
});
