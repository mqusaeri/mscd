// A disposal deletes the content of a record (product owner decision 18, Milestone 3 D.8, M3-13), against the demo data
// with a real storage gateway on SeaweedFS (R-20: the bucket is the test's own). For an audit event (with its
// activities and preparation tasks), a closed major finding, a closed corrective action, a closed management review
// (with its inputs) and a lapsed competence record: the text and person columns are cleared and `disposed_at` set, the
// CHECKs of a closed record accept the cleared row, the item title of the review is removed, and every audit entry of
// the record and of its child rows keeps its keys with null values and no network address, under one
// `privacy.audit_redacted` attestation per disposal, before `record.disposed` is written. The tenant chain verifies and
// breaks when a cleared row changes without an attestation; `platform.redact_audit_rows` refuses the mode
// `clear_disposed` for a record that is not disposed (as mscd_app); the organisation export leaves the disposed rows out
// and `export verify` passes; the personal data copy leaves out the disposed competence record; a competence record
// whose proof is the current file of an evidence item is disposed and the evidence file still opens (security review
// 2); and the column test fails on a text or person column of these tables that is neither cleared nor kept with a
// reason. Organisation `ndt`, system `qms` (rina and sari are its managers).
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult, Page, RetentionReviewItem, UploadIntent, UploadResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportOrganization, exportVerify } from '../../../src/cli/export';
import { signAnchor } from '../../../src/modules/audit/anchors';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { personalDataOf } from '../../../src/modules/exports/personal-data';
import { DISPOSAL_CHILDREN, DISPOSAL_CLEARS, DISPOSAL_KEEPS, type DisposalTable } from '../../../src/modules/retention/retention-model';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { inScope } from '../db/helpers';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, signIn, startStorageStack, type FilesClient, type StorageStack } from '../files/helpers';
import { createRetentionApp, msIdOf, reviewsOf, rowsOf, vaultStat, type RetentionApp } from './helpers';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const ANCHOR_KEY_FILE = path.resolve(__dirname, '../../fixtures/secrets/audit-anchor.key');
const START = '2026-06-15';
const ENDS = '2026-09-15';
const ORG_ID = '00000000-0000-4000-8000-00000000a001';
const TABLES: readonly DisposalTable[] = [
  'audit_event', 'audit_prep_task', 'audit_activity', 'finding', 'corrective_action', 'management_review', 'management_review_input', 'competence_record',
];
type RecordClass = 'audit_event' | 'finding' | 'corrective_action' | 'management_review' | 'competence_record';
const CLASSES: readonly RecordClass[] = ['audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record'];

describe('a disposal deletes the content of a record (decision 18, M3-13)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: RetentionApp;
  let rina: FilesClient;
  let sari: FilesClient;
  let bagus: FilesClient;
  let qms: string;
  let evidenceCode: string;
  let proofObject: string;
  const items = {} as Record<RecordClass, string>;
  const childIds = {} as Record<'audit_activity' | 'audit_prep_task' | 'management_review_input', string>;
  /** Audit entries written for the items and their child rows, by record class. */
  const entries = {} as Record<RecordClass, string[]>;
  let controlSeq: string;
  let controlFinding: string;

  const url = (p: string) => `/api/v1/ms/qms/retention${p}`;
  /** Writes an audit entry of the organisation with values and a network address (the chain trigger links it). */
  const entry = async (type: string, id: string, code: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null): Promise<string> => {
    const [row] = await rowsOf<{ seq: string }>(db, 'ndt', sql`
      insert into audit_trail (organization_id, actor_user_id, actor_kind, action, management_system_id, entity_type, entity_id, entity_code, before_data, after_data, source_ip, user_agent)
      values (${ORG_ID}::uuid, ${rina.userId}::uuid, 'user', ${`${type}.updated`}, ${qms}::uuid, ${type}, ${id}::uuid, ${code},
              ${before ? JSON.stringify(before) : null}::jsonb, ${JSON.stringify(after)}::jsonb, '198.51.100.7'::inet, 'Test browser')
      returning seq::text as seq`);
    return row!.seq;
  };
  const row = async (table: string, id: string) =>
    (await rowsOf<Record<string, unknown>>(db, 'ndt', sql`select * from ${sql.table(table)} where id = ${id}::uuid`))[0]!;

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createRetentionApp(db, stack.gateway.url);
    rina = await signIn(ctx as never, db, 'rina', 'ndt');
    sari = await signIn(ctx as never, db, 'sari', 'ndt');
    bagus = await signIn(ctx as never, db, 'bagus', 'ndt');
    qms = await msIdOf(db, 'ndt', 'qms');
    for (const recordClass of CLASSES) {
      const put = await rina.call<CommandResult>('PUT', url(`/rules/${recordClass}`), { retainMonths: 3, basis: 'Short period of the test' });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }

    // The current file of a live evidence item, uploaded through the gateway: the proof of the competence record.
    const [evidence] = await rowsOf<{ id: string; code: string }>(db, 'ndt', sql`
      insert into evidence (evidence_code, title, owner_user_id, frequency_code)
      values ('DC-EV-1', 'Training certificate of the warehouse lead', ${sari.userId}::uuid, 'annual') returning id, evidence_code as code`);
    await rowsOf(db, 'ndt', sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary) values ('evidence', ${evidence!.id}::uuid, ${qms}::uuid, true) returning id`);
    evidenceCode = evidence!.code;
    const intent = await rina.post<UploadIntent>('/api/v1/storage/upload-intents', { ms: 'qms', kind: 'evidence', recordId: evidence!.id, fileName: 'Certificate.pdf', size: PDF.length });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const put = await rina.put<UploadResult>(intent.body.contentUrl!, PDF);
    expect(put.status).toBe(200);
    proofObject = put.body.storageObjectId;
    await rowsOf(db, 'ndt', sql`update evidence set storage_object_id = ${proofObject}::uuid, produced_at = '2025-06-01' where id = ${evidence!.id}::uuid returning id`);

    const [def] = await rowsOf<{ id: string }>(db, 'ndt', sql`
      select d.id from ref.review_input_def d join management_system m on m.framework_version_id = d.framework_version_id where m.slug = 'qms' order by d.sort_order limit 1`);
    await inOrg(db, 'ndt', async (trx) => {
      const event = await trx.insertInto('audit_event').values({
        management_system_id: qms, event_type: 'special', name_en: 'Special audit of Andi Wibisono', name_id: 'Audit khusus Andi Wibisono', short_label: 'DC-AE-1',
        scheduled_at: '2026-06-13', audit_days: 3, outcome: 'recommended', lead_auditor_name: 'Andi Wibisono', expected_focus: 'Purchasing of Andi Wibisono',
        outcome_summary: 'No major issue', scope_text: 'Warehouse run by Andi Wibisono',
      }).returning('id').executeTakeFirstOrThrow();
      items.audit_event = event.id;
      childIds.audit_activity = (await trx.insertInto('audit_activity').values({
        audit_event_id: event.id, management_system_id: qms, title: 'Interview with Andi Wibisono', key_questions: 'How does Andi approve orders?',
        evidence_to_request: 'Orders of Andi', note: 'Andi was helpful', auditee_user_id: bagus.userId, auditor_user_id: rina.userId, status: 'done', clause_ref: '8.4',
      }).returning('id').executeTakeFirstOrThrow()).id;
      childIds.audit_prep_task = (await trx.insertInto('audit_prep_task').values({
        audit_event_id: event.id, management_system_id: qms, title: 'Collect the logs of Andi Wibisono', owner_user_id: sari.userId, due_at: '2026-06-01',
        note: 'Ask Andi', status: 'done',
      }).returning('id').executeTakeFirstOrThrow()).id;
      items.finding = (await trx.insertInto('finding').values({
        management_system_id: qms, code: 'DC-F-1', title: 'Andi Wibisono skipped the supplier review', classification: 'major', source: 'internal_audit',
        status: 'closed', status_note: 'Andi agreed', closed_at: START, closed_by_user_id: rina.userId, owner_user_id: sari.userId,
        rca_text: 'Andi had no checklist', systemic_check_text: 'Other buyers checked', close_note: 'Verified with Andi',
      }).returning('id').executeTakeFirstOrThrow()).id;
      items.corrective_action = (await trx.insertInto('corrective_action').values({
        management_system_id: qms, code: 'DC-CA-1', title: 'Checklist for Andi Wibisono', owner_user_id: sari.userId, status: 'closed',
        correction_text: 'Andi reviewed the supplier', rca_text: 'No checklist', systemic_check_text: 'Two buyers', action_text: 'Checklist added',
        implemented_by_user_id: bagus.userId, implemented_at: '2026-06-01', verified_by_user_id: rina.userId, verified_at: START, effective: true,
        verification_note: 'Andi uses it',
      }).returning('id').executeTakeFirstOrThrow()).id;
      const review = await trx.insertInto('management_review').values({
        code: 'DC-MR-1', title: 'Review with Andi Wibisono', owner_user_id: sari.userId, status: 'closed', decisions_recorded: true,
        decisions_text: 'Andi leads the supplier programme', closed_at: START, closed_by_user_id: rina.userId, held_at: '2026-06-10',
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'management_review', entity_id: review.id, management_system_id: qms, is_primary: true }).execute();
      items.management_review = review.id;
      childIds.management_review_input = (await trx.insertInto('management_review_input').values({
        management_review_id: review.id, review_input_def_id: def!.id, management_system_id: qms, content: 'Complaints about Andi rose',
      }).returning('id').executeTakeFirstOrThrow()).id;
      const competence = await trx.insertInto('competence_record').values({
        user_id: bagus.userId, role_title: 'Warehouse lead', competence_required: 'Forklift licence of Andi', proof_type: 'certificate',
        storage_object_id: proofObject, achieved_at: '2024-01-10', valid_until: START, owner_user_id: sari.userId, verified_by: rina.userId,
        pending_action: 'Renew the licence',
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('entity_ms_link').values({ entity_type: 'competence_record', entity_id: competence.id, management_system_id: qms, is_primary: true }).execute();
      items.competence_record = competence.id;
      controlFinding = (await trx.insertInto('finding').values({
        management_system_id: qms, code: 'DC-F-2', title: 'Open finding of Andi Wibisono', classification: 'minor', source: 'other', status: 'open', owner_user_id: sari.userId,
      }).returning('id').executeTakeFirstOrThrow()).id;
    });
    entries.audit_event = [
      await entry('audit_event', items.audit_event, 'DC-AE-1', { leadAuditorName: 'Andi Wibisono', scope: ['Warehouse', 'Purchasing'] }),
      await entry('audit_activity', childIds.audit_activity, '8.4', { note: 'Andi was helpful' }, { note: null }),
      await entry('audit_prep_task', childIds.audit_prep_task, 'Collect', { title: 'Collect the logs of Andi Wibisono' }),
    ];
    entries.finding = [await entry('finding', items.finding, 'DC-F-1', { rcaText: 'Andi had no checklist', classification: 'major' })];
    entries.corrective_action = [await entry('corrective_action', items.corrective_action, 'DC-CA-1', { actionText: 'Checklist added', effective: true })];
    entries.management_review = [await entry('management_review', items.management_review, 'DC-MR-1', { input: 'complaints', content: 'Complaints about Andi rose' })];
    entries.competence_record = [await entry('competence_record', items.competence_record, 'CMP', { competenceRequired: 'Forklift licence of Andi', personHandle: 'bagus' })];
    controlSeq = await entry('finding', controlFinding, 'DC-F-2', { title: 'Open finding of Andi Wibisono' });

    ctx.setToday(ENDS);
    await ctx.review('ndt');
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('lists the files of a review item, a file another record uses as kept in use', async () => {
    const list = await rina.get<Page<RetentionReviewItem>>(url('/reviews?status=open&recordClass=competence_record&pageSize=100'));
    expect(list.status).toBe(200);
    const review = list.body.items.find((r) => r.itemId === items.competence_record)!;
    expect(review.files).toEqual([{ name: 'Certificate.pdf', repository: expect.any(String), action: 'kept_in_use', usedBy: evidenceCode }]);
  });

  it('clears the text and person columns of every class and its child rows, and redacts their audit entries under one attestation', async () => {
    for (const recordClass of CLASSES) {
      const review = (await reviewsOf(db, 'ndt', items[recordClass])).find((r) => r.status === 'open')!;
      expect(review, recordClass).toBeDefined();
      expect(review.item_title, recordClass).not.toBeNull();
      const decided = await rina.post(url('/reviews/decide'), { ids: [review.id], decision: 'dispose', reason: 'Period over' });
      expect(decided.status, `${recordClass} ${JSON.stringify(decided.body)}`).toBe(200);
      const approved = await sari.post<CommandResult>(url(`/reviews/${review.id}/approve`), {});
      expect(approved.status, `${recordClass} ${JSON.stringify(approved.body)}`).toBe(200);
      expect(approved.body.data, recordClass).toMatchObject({ recordDeleted: true });

      // The record: cleared columns, kept codes and statuses, marked deleted and disposed.
      const table = recordClass as DisposalTable;
      const stored = await row(table, items[recordClass]);
      for (const column of DISPOSAL_CLEARS[table].nulls) expect([recordClass, column, stored[column]]).toEqual([recordClass, column, null]);
      for (const [column, text] of Object.entries(DISPOSAL_CLEARS[table].texts)) expect([recordClass, column, stored[column]]).toEqual([recordClass, column, text]);
      expect(stored.disposed_at, recordClass).toBeInstanceOf(Date);
      expect(stored.deleted_at, recordClass).toBeInstanceOf(Date);
      expect(stored.updated_by, recordClass).toBe(sari.userId);
      expect(JSON.stringify(stored), recordClass).not.toMatch(/Andi/);
      for (const child of DISPOSAL_CHILDREN[table] ?? []) {
        const childRow = await row(child.table, childIds[child.table as keyof typeof childIds]);
        for (const column of DISPOSAL_CLEARS[child.table].nulls) expect([child.table, column, childRow[column]]).toEqual([child.table, column, null]);
        expect(JSON.stringify(childRow), child.table).not.toMatch(/Andi/);
      }
      expect((await reviewsOf(db, 'ndt', items[recordClass]))[0]!.item_title, recordClass).toBeNull();

      // The audit entries keep their keys with null values, without network address or browser, under one attestation.
      const attestations = await rowsOf<{ seq: string; after: { rows: { seq: number }[]; reason: string } }>(db, 'ndt', sql`
        select seq::text as seq, after_data as after from audit_trail where action = 'privacy.audit_redacted' and entity_type = 'retention_review' and entity_id = ${review.id}::uuid`);
      expect(attestations, recordClass).toHaveLength(1);
      expect(attestations[0]!.after.reason).toBe(`Disposal of ${review.item_code}, retention review ${review.id}`);
      expect(attestations[0]!.after.rows.map((r) => String(r.seq)).sort()).toEqual(expect.arrayContaining(entries[recordClass]));
      for (const seq of entries[recordClass]) {
        const [redacted] = await rowsOf<{ after: Record<string, unknown>; before: Record<string, unknown> | null; ip: string | null; agent: string | null; code: string | null }>(db, 'ndt', sql`
          select after_data as after, before_data as before, host(source_ip) as ip, user_agent as agent, entity_code as code from audit_trail where seq = ${seq}::bigint`);
        expect(redacted!.ip).toBeNull();
        expect(redacted!.agent).toBeNull();
        expect(redacted!.code).not.toBeNull();
        expect(Object.keys(redacted!.after).length).toBeGreaterThan(0);
        for (const value of Object.values(redacted!.after)) expect(JSON.stringify(value)).toMatch(/^(null|\[null(,null)*\])$/);
        if (redacted!.before) for (const value of Object.values(redacted!.before)) expect(value).toBeNull();
      }
      // record.disposed comes after the attestation and keeps its values.
      const [disposed] = await rowsOf<{ seq: string; after: Record<string, unknown> }>(db, 'ndt', sql`
        select seq::text as seq, after_data as after from audit_trail where action = 'record.disposed' and entity_id = ${items[recordClass]}::uuid order by seq desc limit 1`);
      expect(BigInt(disposed!.seq) > BigInt(attestations[0]!.seq)).toBe(true);
      expect(disposed!.after).toMatchObject({ deleted: true, recordClass, contentCleared: true, reviewId: review.id });
    }
    // The control entry of a finding that is not disposed is unchanged.
    const [control] = await rowsOf<{ text: string; ip: string | null }>(db, 'ndt', sql`select after_data::text as text, host(source_ip) as ip from audit_trail where seq = ${controlSeq}::bigint`);
    expect(control).toMatchObject({ ip: '198.51.100.7' });
    expect(control!.text).toContain('Andi Wibisono');
  });

  it('keeps the proof file of the disposed competence record that the evidence item still uses, and it still opens', async () => {
    const [disposed] = await rowsOf<{ after: Record<string, unknown> }>(db, 'ndt', sql`
      select after_data as after from audit_trail where action = 'record.disposed' and entity_id = ${items.competence_record}::uuid`);
    expect(disposed!.after).toMatchObject({ keptInUse: [{ objectId: proofObject, usedBy: evidenceCode }], fileAction: 'none' });
    const [object] = await rowsOf<{ disposed: boolean }>(db, 'ndt', sql`select content_disposed_at is not null as disposed from storage_object where id = ${proofObject}::uuid`);
    expect(object).toEqual({ disposed: false });
    expect(await vaultStat(ctx, db, 'ndt', proofObject)).toBe('found');
    const opened = await rina.get(`/api/v1/storage/objects/${proofObject}/open?ms=qms`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  });

  it('verifies the tenant chain, and breaks it when a cleared row changes without an attestation', async () => {
    const verifier = ctx.moduleRef.get(AuditChainVerifier);
    const tenant = { orgId: ORG_ID, schema: 'org_ndt' };
    const before = await verifier.verifyTenant(tenant);
    expect(before.firstBrokenSeq).toBeNull();
    expect(before.redacted).toBeGreaterThanOrEqual(7);
    const seq = entries.finding[0]!;
    const [stored] = await rowsOf<{ after: unknown }>(db, 'ndt', sql`select after_data as after from audit_trail where seq = ${seq}::bigint`);
    const write = (value: unknown) => inScope(db.migrator, { orgId: ORG_ID, schema: 'org_ndt' }, async (trx) => {
      await sql`alter table audit_trail disable trigger audit_trail_append_only`.execute(trx);
      await sql`update audit_trail set after_data = ${JSON.stringify(value)}::jsonb where seq = ${seq}::bigint`.execute(trx);
      await sql`alter table audit_trail enable trigger audit_trail_append_only`.execute(trx);
    });
    await write({ rcaText: 'Andi had no checklist', classification: 'major' });
    expect((await verifier.verifyTenant(tenant)).firstBrokenSeq).not.toBeNull();
    await write(stored!.after);
    expect((await verifier.verifyTenant(tenant)).firstBrokenSeq).toBeNull();
  });

  it('refuses the mode clear_disposed for a record that is not disposed, called as mscd_app', async () => {
    const call = (chain: string, payload: Record<string, unknown>) =>
      inScope(db.app, { orgId: ORG_ID, schema: 'org_ndt', userId: rina.userId }, (trx) =>
        sql`select platform.redact_audit_rows(${chain}, ${[controlSeq]}::bigint[], gen_random_uuid(), ${JSON.stringify(payload)}::jsonb)`.execute(trx));
    const attestation = { action: 'privacy.audit_redacted', reason: 'Disposal of DC-F-2' };
    await expect(call('org_ndt.audit_trail', { mode: 'clear_disposed', attestation })).rejects.toThrow(/is not about a disposed record/);
    await expect(call('org_ndt.audit_trail', { mode: 'clear_disposed', values: { 'Andi Wibisono': 'Former user 1A2B' }, attestation })).rejects.toThrow(/takes no replacement values/);
    await expect(call('platform.audit_log', { mode: 'clear_disposed', attestation: { ...attestation, action: 'tenant.audit_redacted' } })).rejects.toThrow(/audit trail of one organisation only/);
    const [control] = await rowsOf<{ redacted: boolean }>(db, 'ndt', sql`select redaction_id is not null as redacted from audit_trail where seq = ${controlSeq}::bigint`);
    expect(control).toEqual({ redacted: false });
  });

  it('leaves the disposed rows and their child rows out of the organisation export, which verifies', async () => {
    // A signed anchor at the head of the chain (the anchor job's format, with the key of the test profile).
    const privateKey = createPrivateKey(await readFile(ANCHOR_KEY_FILE));
    const [head] = await rowsOf<{ seq: string; row_hash: string }>(db, 'ndt', sql`select t.seq::text as seq, encode(t.row_hash, 'hex') as row_hash from audit_trail t order by t.seq desc limit 1`);
    const installation = await inScope(db.migrator, { platformScope: true }, (trx) => trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow());
    const anchored = signAnchor({ chain: 'org_ndt.audit_trail', seq: Number(head!.seq), rowHash: head!.row_hash, anchoredAt: new Date().toISOString(), installationId: installation.id },
      privateKey, createPublicKey(privateKey));
    await sql`insert into platform.audit_anchor (chain, seq, row_hash, payload, signature, key_id)
      values (${anchored.chain}, ${anchored.seq}, ${Buffer.from(anchored.rowHash, 'hex')},
              ${JSON.stringify({ chain: anchored.chain, seq: anchored.seq, rowHash: anchored.rowHash, anchoredAt: anchored.anchoredAt, installationId: anchored.installationId })},
              ${anchored.signature}, ${anchored.keyId})`.execute(db.migrator);

    // The demo's Managed Vault objects have no bytes in this test's SeaweedFS: they are marked disposed here (a throwaway
    // copy of the demo, R-20), so the export lists them without content and reads only the file this test uploaded.
    await rowsOf(db, 'ndt', sql`
      update storage_object set content_disposed_at = now()
       where id <> ${proofObject}::uuid and content_disposed_at is null
         and storage_repository_id in (select id from storage_repository where adapter = 'managed_vault')
      returning id`);
    const work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-13-disposal-'));
    try {
      const config = db.config({ MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      const out = path.join(work, 'export');
      const result = await exportOrganization(config, { out, org: 'ndt' });
      const manifest = JSON.parse(await readFile(path.join(out, result.manifestFile), 'utf8')) as {
        entries: { path: string; rows?: number }[];
        excluded: { item: string; reason: string }[];
      };
      for (const table of TABLES) {
        const parent = DISPOSAL_CHILDREN.audit_event?.some((c) => c.table === table) ? 'audit_event'
          : DISPOSAL_CHILDREN.management_review?.some((c) => c.table === table) ? 'management_review' : null;
        const counted = parent
          ? await rowsOf<{ n: number }>(db, 'ndt', sql`
              select count(*)::int as n from ${sql.table(table)} c where not exists (select 1 from ${sql.table(parent)} p where p.id = c.${sql.ref(`${parent}_id`)} and p.disposed_at is not null)`)
          : await rowsOf<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from ${sql.table(table)} where disposed_at is null`);
        const all = await rowsOf<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from ${sql.table(table)}`);
        expect(counted[0]!.n, table).toBe(all[0]!.n - 1);
        expect(manifest.entries.find((e) => e.path === `data/tenant/${table}.jsonl`)?.rows, table).toBe(counted[0]!.n);
        expect(manifest.excluded.find((e) => e.item === `${table} (some rows)`)?.reason, table).toMatch(/disposed of under a retention rule/i);
      }
      const report = await exportVerify(out);
      expect(report.problems).toEqual([]);
      expect(report.ok).toBe(true);
      // Every entry of the disposed records is redacted, and the anchor at the head of the chain covers its attestation.
      expect(report.redactedRows).toBeGreaterThanOrEqual(7);
      expect(report.redactedUnanchored).toBe(0);
      expect(report.lastAnchoredSeq).toBe(Number(head!.seq));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('leaves the disposed competence record out of the personal data copy', async () => {
    const scope = ctx.moduleRef.get(TenantScope);
    const copy = await scope.withTenant({ orgId: ORG_ID, schema: 'org_ndt', userId: rina.userId }, (trx) =>
      personalDataOf(trx, { id: ORG_ID, name: 'Nusantara Digital', slug: 'ndt' }, bagus.userId, new Date()));
    expect(JSON.stringify(copy.competenceRecords)).not.toMatch(/Warehouse lead|Forklift/);
    expect(JSON.stringify(copy.records)).not.toContain(items.competence_record);
  });

  it('holds every text and person column of these tables in the cleared or the kept list', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select c.table_name, c.column_name from information_schema.columns c
       where c.table_schema = 'org_ndt' and c.table_name = any(${[...TABLES]}::text[])
         and (c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
              or exists (select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
                          where k.contype = 'f' and k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                            and a.attname = c.column_name and k.confrelid = 'platform.app_user'::regclass))
       order by c.table_name, c.column_name`.execute(db.migrator);
    const unlisted = (columns: { table_name: string; column_name: string }[]) => columns.filter(({ table_name: t, column_name: c }) => {
      const table = t as DisposalTable;
      return !DISPOSAL_CLEARS[table].nulls.includes(c) && !(c in DISPOSAL_CLEARS[table].texts) && !(c in DISPOSAL_KEEPS[table]);
    }).map((r) => `${r.table_name}.${r.column_name}`);
    expect(rows.length).toBeGreaterThan(30);
    expect(unlisted(rows)).toEqual([]);
    // A new free-text column that is in neither list fails the test.
    expect(unlisted([...rows, { table_name: 'finding', column_name: 'auditor_comment' }])).toEqual(['finding.auditor_comment']);
    // Every listed column exists, with a reason for each kept one.
    const existing = new Set((await sql<{ name: string }>`
      select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'org_ndt' and table_name = any(${[...TABLES]}::text[])`
      .execute(db.migrator)).rows.map((r) => r.name));
    for (const table of TABLES) {
      for (const column of [...DISPOSAL_CLEARS[table].nulls, ...Object.keys(DISPOSAL_CLEARS[table].texts), ...Object.keys(DISPOSAL_KEEPS[table])]) {
        expect(existing.has(`${table}.${column}`), `${table}.${column}`).toBe(true);
      }
      for (const reason of Object.values(DISPOSAL_KEEPS[table])) expect(reason.length).toBeGreaterThan(5);
    }
  });
});
