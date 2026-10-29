// Bulk import (Milestone 2 D.1, D2-13, M2-08): templates that match the exports, the dry run of every row, the
// commit of every row or none in one transaction through the command services, and the rules around it: the creator
// only, the kind's permission at upload and again at commit, one commit per file, formula cells read as text (F.15).
import { ImportRun } from '@mscd/shared';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedApplicability } from '../../../src/modules/implementation/applicability-seed';
import { ImportRunJob } from '../../../src/modules/imports/import-run.job';
import { useTestDatabase } from '../../setup/test-db';
import { chainVerificationQuery } from '../db/helpers';
import {
  DOC_HEADER, SOA_HEADER, TST, addFixtureUser, auditOf, commit, createFullApp, csvOf, demoSession, importFile, inOrg, msIdOf, notificationsOf, rowsIn,
  runImportJobs, sessionFor, upload, xlsxOf, type Client, type FullApp,
} from './helpers';

interface Control {
  code: string;
  id: string;
  applies: boolean;
  owner: string | null;
}

describe('bulk import (M2-08)', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let isms: string;
  let people: { handle: string; email: string; name: string }[];

  const controls = async (): Promise<Control[]> =>
    rowsIn<Control>(db, 'tst', sql`
      select ci.item_code as code, e.id, (e.is_applicable is not false and e.implementation_status is distinct from 'not_applicable') as applies,
             o.handle as owner
        from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join platform.app_user o on o.id = e.owner_user_id
       where e.management_system_id = ${isms} and e.deleted_at is null order by ci.sort_order`);

  const entry = async (code: string) =>
    (await rowsIn<{ inclusion: string | null; exclusion: string | null; owner: string | null; status: string | null; note: string | null; updated_at: Date }>(db, 'tst', sql`
      select e.inclusion_justification as inclusion, e.exclusion_justification as exclusion, o.handle as owner, e.implementation_status as status,
             e.status_note as note, e.updated_at
        from applicability_entry e left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement rq on rq.id = e.requirement_id
        left join platform.app_user o on o.id = e.owner_user_id
       where e.management_system_id = ${isms} and e.deleted_at is null and coalesce(ci.item_code, rq.requirement_code) = ${code}`))[0]!;

  /** An SoA row with the export's columns: ID, applicable, justification and owner (the read-only columns empty). */
  const soaRow = (code: string, applicable: string, justification: unknown, owner: string) =>
    [code, '', '', applicable, justification, '', owner, '', '', '', '', ''] as (string | { formula: string })[];

  /** The F.11 verification of the organisation's audit chain: the first broken sequence number, or null. */
  const firstBrokenSeq = async (): Promise<string | null> =>
    inOrg(db, 'tst', async (trx) => (await chainVerificationQuery('audit_trail').execute(trx)).rows[0]!.first_broken_seq);

  /**
   * An audited write of the organisation by someone else, in a transaction of its own with a statement timeout (the
   * application role has 30 seconds in Compose and SaaS installs): its duration in milliseconds and its sequence number.
   */
  const otherAuditedWrite = async (timeout: string): Promise<{ ms: number; seq: string }> => {
    const started = Date.now();
    const seq = await inOrg(db, 'tst', async (trx) => {
      await sql`select set_config('statement_timeout', ${timeout}, true)`.execute(trx);
      const { rows } = await sql<{ seq: string }>`
        insert into audit_trail (actor_kind, action, entity_type) values ('system', 'test.concurrent_write', 'test') returning seq`.execute(trx);
      return rows[0]!.seq;
    });
    return { ms: Date.now() - started, seq };
  };

  /**
   * Runs the queued import jobs with the commit stopped after its first applicability row (its transaction open, the
   * import's row locked), calls `whileHeld`, then lets the commit finish: what `whileHeld` gave and the jobs' results.
   */
  const withCommitHeld = async <T>(whileHeld: () => Promise<T>): Promise<{ held: T; results: Awaited<ReturnType<typeof runImportJobs>> }> => {
    const service = (full.get<ImportRunJob>(ImportRunJob) as unknown as { applicability: { update: (...args: unknown[]) => Promise<unknown> } }).applicability;
    const update = service.update;
    let reached!: () => void;
    let release!: () => void;
    const midway = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    // The first row is applied (its audit entry recorded in the commit's transaction), then the commit waits.
    service.update = async (...args: unknown[]) => {
      const out = await update.apply(service, args);
      calls += 1;
      if (calls === 1) {
        reached();
        await gate;
      }
      return out;
    };
    let running: ReturnType<typeof runImportJobs> | undefined;
    try {
      running = runImportJobs(full);
      await Promise.race([midway, running.then(() => Promise.reject(new Error('The commit ended before its first row was held')))]);
      const held = await whileHeld();
      release();
      return { held, results: await running };
    } finally {
      service.update = update;
      release();
      await running?.catch(() => undefined);
    }
  };

  /** `promise`, or a rejection after `ms` milliseconds naming `what`. */
  const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)));
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };

  beforeAll(async () => {
    full = await createFullApp(db);
    rina = await demoSession(full, db, 'rina', 'tst');
    bagus = await demoSession(full, db, 'bagus', 'tst');
    maya = await demoSession(full, db, 'maya', 'tst');
    isms = await msIdOf(db, 'tst', 'isms');
    // A system with seeded entries (D2-09): every Annex A control and every clause row of the edition.
    await inOrg(db, 'tst', (trx) => seedApplicability(trx, isms));
    people = await rowsIn(db, 'tst', sql`
      select u.handle, u.email, u.display_name as name from platform.app_user u where u.handle in ('bagus', 'maya', 'hendra', 'rina') order by u.handle`);
  });

  afterAll(async () => {
    await full?.close();
  });

  it('gives XLSX templates whose header row matches the exports, with an Allowed values sheet', async () => {
    const template = await rina.get(`/api/v1/ms/isms/imports/templates/applicability`);
    expect(template.status).toBe(200);
    expect(template.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(String(template.headers['content-disposition'])).toMatch(/^attachment; filename="ISMS-import-applicability\.xlsx"/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(template.raw.rawPayload as unknown as ArrayBuffer);
    const headerOf = (sheet: ExcelJS.Worksheet) => (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    expect(headerOf(book.worksheets[0]!)).toEqual([...SOA_HEADER, 'Risks', 'Status note']);
    expect(book.worksheets[0]!.rowCount).toBe(1);
    const help = book.getWorksheet('Allowed values')!;
    const helpText = JSON.stringify(help.getSheetValues());
    for (const text of ['annual', 'A.5.1', 'Cl. 4.1', 'What it takes', 'Yes or No']) expect(helpText).toContain(text);
    // No person of the organisation is listed: the template is open to everyone who reads the system.
    expect(helpText).not.toContain('bagus');

    // The real SoA export has the same first twelve columns.
    const exported = await rina.get('/api/v1/ms/isms/applicability/export?format=xlsx');
    expect(exported.status).toBe(200);
    const exportBook = new ExcelJS.Workbook();
    await exportBook.xlsx.load(exported.raw.rawPayload as unknown as ArrayBuffer);
    expect(headerOf(exportBook.worksheets[0]!)).toEqual(SOA_HEADER);

    const documents = await rina.get('/api/v1/ms/isms/imports/templates/documents', { 'accept-language': 'id' });
    expect(documents.status).toBe(200);
    const docBook = new ExcelJS.Workbook();
    await docBook.xlsx.load(documents.raw.rawPayload as unknown as ArrayBuffer);
    expect(headerOf(docBook.worksheets[0]!).slice(0, 4)).toEqual(['ID', 'Judul', 'Jenis', 'Versi']);
    expect(docBook.getWorksheet('Nilai yang diizinkan')).toBeTruthy();
    const english = await rina.get('/api/v1/ms/isms/imports/templates/documents');
    const englishBook = new ExcelJS.Workbook();
    await englishBook.xlsx.load(english.raw.rawPayload as unknown as ArrayBuffer);
    expect(headerOf(englishBook.worksheets[0]!).slice(0, DOC_HEADER.length)).toEqual(DOC_HEADER);
    // The app language (the lang query the screen sends) wins over the browser's Accept-Language, both ways.
    const appIndonesian = await rina.get('/api/v1/ms/isms/imports/templates/documents?lang=id', { 'accept-language': 'en-GB,en;q=0.9' });
    const appIdBook = new ExcelJS.Workbook();
    await appIdBook.xlsx.load(appIndonesian.raw.rawPayload as unknown as ArrayBuffer);
    expect(headerOf(appIdBook.worksheets[0]!).slice(0, 2)).toEqual(['ID', 'Judul']);
    expect(appIdBook.getWorksheet('Nilai yang diizinkan')).toBeTruthy();
    const appEnglish = await rina.get('/api/v1/ms/isms/imports/templates/documents?lang=en', { 'accept-language': 'id-ID,id;q=0.9' });
    const appEnBook = new ExcelJS.Workbook();
    await appEnBook.xlsx.load(appEnglish.raw.rawPayload as unknown as ArrayBuffer);
    expect(headerOf(appEnBook.worksheets[0]!).slice(0, DOC_HEADER.length)).toEqual(DOC_HEADER);
    expect(appEnBook.getWorksheet('Allowed values')).toBeTruthy();
    expect((await rina.get('/api/v1/ms/isms/imports/templates/documents?lang=fr')).status).toBe(400);
    for (const kind of ['risks', 'evidence']) expect((await maya.get(`/api/v1/ms/isms/imports/templates/${kind}`)).status).toBe(200);
  });

  it('updates the justifications and owners of the 93 controls of a system with seeded entries in one commit', async () => {
    const before = await controls();
    expect(before).toHaveLength(93);
    const [b, h, m] = [people.find((p) => p.handle === 'bagus')!, people.find((p) => p.handle === 'hendra')!, people.find((p) => p.handle === 'maya')!];
    // Owners as a handle, an email and a full name, as people write them.
    const ownerCell = (i: number) => [b.handle, h.email, m.name][i % 3]!;
    const ownerHandle = (i: number) => [b.handle, h.handle, m.handle][i % 3]!;
    const rows = before.map((c, i) => soaRow(c.code, c.applies ? 'Yes' : 'No', `Imported for ${c.code}: covered by the information security programme of 2026`, ownerCell(i)));
    const file = await xlsxOf(SOA_HEADER, rows, { help: true, sheet: 'Statement of Applicability' });

    const checked = await upload(rina, 'isms', 'applicability', 'soa-2026.xlsx', file);
    expect(checked.status, checked.text).toBe(201);
    expect(ImportRun.safeParse(checked.body).success).toBe(true);
    expect(checked.body).toMatchObject({ kind: 'applicability', fileName: 'soa-2026.xlsx', status: 'validated', rowCount: 93, counts: { ok: 93, warning: 0, error: 0 } });
    expect(checked.body.results).toHaveLength(93);
    expect(checked.body.results[0]).toEqual({ row: 1, status: 'ok', messages: [], code: before[0]!.code, action: 'update' });

    const queued = await commit(rina, 'isms', checked.body.id);
    expect(queued.status, queued.text).toBe(202);
    expect(queued.body.taskId).toBeTruthy();
    expect((await rina.get<ImportRun>(`/api/v1/ms/isms/imports/${checked.body.id}`)).body).toMatchObject({ status: 'committing', taskId: queued.body.taskId, progress: 0 });
    const [result] = await runImportJobs(full);
    expect(result).toMatchObject({ status: 'committed', summary: { created: 0, updated: 93, unchanged: 0 } });

    const done = await rina.get<ImportRun>(`/api/v1/ms/isms/imports/${checked.body.id}`);
    expect(done.status).toBe(200);
    expect(ImportRun.safeParse(done.body).success).toBe(true);
    expect(done.body).toMatchObject({ status: 'committed', progress: 100, summary: { created: 0, updated: 93, unchanged: 0 }, changed: ['isms'] });
    expect(done.body.committedAt).toBeTruthy();

    const after = await controls();
    for (const [i, c] of after.entries()) {
      const stored = await entry(c.code);
      expect(c.owner, c.code).toBe(ownerHandle(i));
      expect(c.applies ? stored.inclusion : stored.exclusion, c.code).toBe(`Imported for ${c.code}: covered by the information security programme of 2026`);
    }
    // One transaction: every changed row carries the same transaction id.
    const [{ n }] = await rowsIn<{ n: number }>(db, 'tst', sql`
      select count(distinct xmin::text)::int as n from applicability_entry where id = any(${after.map((c) => c.id)}::uuid[])`) as [{ n: number }];
    expect(n).toBe(1);
    // Every row went through the command service and its audit entry, with the person who imported as the actor.
    const updates = (await auditOf(db, 'tst', 'applicability.updated')).filter((a) => after.some((c) => c.id === a.entity_id));
    expect(updates).toHaveLength(93);
    expect(new Set(updates.map((u) => u.actor))).toEqual(new Set(['rina']));
    // The audit entries of the rows are written in the commit's transaction too (ImportHold), and the chain holds.
    const [{ same }] = await rowsIn<{ same: number }>(db, 'tst', sql`
      select count(*)::int as same from audit_trail a
       where a.action = 'applicability.updated' and a.entity_id = any(${after.map((c) => c.id)}::uuid[])
         and a.xmin = (select e.xmin from applicability_entry e where e.id = ${after[0]!.id})`) as [{ same: number }];
    expect(same).toBe(93);
    expect(await firstBrokenSeq()).toBeNull();
    expect((await auditOf(db, 'tst', 'import.validated')).at(-1)).toMatchObject({ entity_type: 'import_run', entity_id: checked.body.id, actor: 'rina', after: { kind: 'applicability', rows: 93, ok: 93 } });
    expect((await auditOf(db, 'tst', 'import.committed')).at(-1)).toMatchObject({ entity_id: checked.body.id, actor: 'rina', after: { kind: 'applicability', updated: 93, created: 0 } });
    expect((await notificationsOf(db, 'tst', 'rina', 'import_finished'))[0]).toMatchObject({ title_en: 'Import finished: Controls and requirements', title_id: 'Impor selesai: Kontrol dan persyaratan' });

    // A second commit of the same import, and the same file uploaded again, are refused.
    const again = await commit(rina, 'isms', checked.body.id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ messageKey: 'imports.not_waiting' });
    const reupload = await upload(rina, 'isms', 'applicability', 'soa-2026-copy.xlsx', file);
    expect(reupload.status).toBe(409);
    expect(reupload.body).toMatchObject({ messageKey: 'imports.already_imported' });
  });

  it('refuses the commit of a second check of a file that was committed since', async () => {
    const [first] = await controls();
    const file = csvOf(['ID', 'Status note'], [[first!.code, 'Reviewed in the October workshop']]);
    const one = await upload(rina, 'isms', 'applicability', 'note.csv', file);
    const two = await upload(rina, 'isms', 'applicability', 'note.csv', file);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect((await commit(rina, 'isms', one.body.id)).status).toBe(202);
    await runImportJobs(full);
    expect((await entry(first!.code)).note).toBe('Reviewed in the October workshop');
    const second = await commit(rina, 'isms', two.body.id);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ messageKey: 'imports.already_imported' });
  });

  it('lets one row with an error block the commit, and applies nothing', async () => {
    const [x, y, z] = await controls();
    const before = await Promise.all([x, y, z].map((c) => entry(c!.code)));
    const file = await xlsxOf(SOA_HEADER, [
      soaRow(x!.code, '', 'Blocked import, row one', 'bagus'),
      soaRow(y!.code, '', 'Blocked import, row two', 'nobody.here'),
      soaRow(z!.code, '', 'Blocked import, row three', 'maya'),
    ]);
    const checked = await upload(rina, 'isms', 'applicability', 'blocked.xlsx', file);
    expect(checked.status).toBe(201);
    expect(checked.body.counts).toEqual({ ok: 2, warning: 0, error: 1 });
    expect(checked.body.results.map((r) => r.status)).toEqual(['ok', 'error', 'ok']);
    expect(checked.body.results[1]!.messages[0]!.en).toBe('Owner: nobody.here is not an active member of this organisation.');
    expect(checked.body.results[1]!.messages[0]!.id).toBe('Pemilik: nobody.here bukan anggota aktif organisasi ini.');
    expect(checked.body.results[1]).not.toHaveProperty('action');
    const refused = await commit(rina, 'isms', checked.body.id);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ messageKey: 'imports.rows_with_errors' });
    expect(await runImportJobs(full)).toEqual([]);
    expect(await Promise.all([x, y, z].map((c) => entry(c!.code)))).toEqual(before);
    expect((await rina.get<ImportRun>(`/api/v1/ms/isms/imports/${checked.body.id}`)).body.status).toBe('validated');
  });

  it('gives the BR-03 warning for each row whose exclusion justification is filler text, without blocking the commit', async () => {
    const all = await controls();
    const [p, q, r] = all.filter((c) => c.applies).slice(-3);
    const file = csvOf(['ID', 'Applicable', 'Justification'], [
      [p!.code, 'No', 'N/A'],
      [q!.code, 'Tidak', 'not applicable'],
      [r!.code, 'No', 'No cloud services are used, so the cloud control does not apply'],
    ], ';');
    const checked = await upload(rina, 'isms', 'applicability', 'exclusions.csv', file);
    expect(checked.status, checked.text).toBe(201);
    expect(checked.body.results.map((x) => x.status)).toEqual(['warning', 'warning', 'ok']);
    for (const row of checked.body.results.slice(0, 2)) {
      expect(row.messages).toEqual([{ en: 'The exclusion justification does not look meaningful. Explain why this does not apply.', id: 'Justifikasi pengecualian tampaknya tidak bermakna. Jelaskan mengapa ini tidak berlaku.' }]);
      expect(row.action).toBe('update');
    }
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(202);
    expect((await runImportJobs(full))[0]).toMatchObject({ status: 'committed' });
    expect(await entry(p!.code)).toMatchObject({ status: 'not_applicable', exclusion: 'N/A' });
    expect(await entry(r!.code)).toMatchObject({ status: 'not_applicable', exclusion: 'No cloud services are used, so the cloud control does not apply' });
  });

  it('never marks a clause row not applicable (APPL-ASSESS) and creates an entry for a control without one', async () => {
    const clause = await upload(rina, 'isms', 'applicability', 'clause.csv', csvOf(['ID', 'Applicable', 'Justification'], [['Cl. 4.1', 'No', 'We think it does not apply to us']]));
    expect(clause.status).toBe(201);
    expect(clause.body.results[0]).toMatchObject({ status: 'error', code: 'Cl. 4.1' });
    expect(clause.body.results[0]!.messages[0]!.en).toContain('Clause requirements always apply');

    const [last] = (await controls()).slice(-1);
    await inOrg(db, 'tst', (trx) => sql`update applicability_entry set deleted_at = now() where id = ${last!.id}`.execute(trx));
    const created = await importFile(full, rina, 'isms', 'applicability', 'new-entry.csv', csvOf(['ID', 'Owner', 'Justification', 'Status note'], [[last!.code, 'bagus', 'Needed for the new data centre', 'Planned for Q1']]));
    expect(created.checked.results[0]).toMatchObject({ action: 'create', status: 'warning' });
    expect(created.checked.results[0]!.messages[0]!.en).toContain('blocks its checkpoint');
    expect(created.done).toMatchObject({ status: 'committed', summary: { created: 1, updated: 0, unchanged: 0 } });
    expect(await entry(last!.code)).toMatchObject({ inclusion: 'Needed for the new data centre', owner: 'bagus', status: 'not_started', note: 'Planned for Q1' });
  });

  it('reads a formula cell as its formula text and stores it as text (F.15)', async () => {
    const [, second] = await controls();
    const formula = 'HYPERLINK("http://attacker.example","Click here")';
    const file = await xlsxOf(SOA_HEADER, [soaRow(second!.code, '', { formula, result: 'Click here' }, '')]);
    const { checked, done } = await importFile(full, rina, 'isms', 'applicability', 'formula.xlsx', file);
    expect(checked.results[0]).toMatchObject({ status: 'ok', action: 'update' });
    expect(done.status).toBe('committed');
    const stored = await entry(second!.code);
    expect(second!.applies ? stored.inclusion : stored.exclusion).toBe(`=${formula}`);
    // A neutralised cell of an export (a leading quote) imports as the text it showed.
    const csv = await importFile(full, rina, 'isms', 'applicability', 'quoted.csv', csvOf(['ID', 'Status note'], [[second!.code, "'=SUM(1+1)"]]));
    expect(csv.done.status).toBe('committed');
    expect((await entry(second!.code)).note).toBe('=SUM(1+1)');
    // The SoA export writes it neutralised again.
    const exported = await rina.get('/api/v1/ms/isms/applicability/export?format=xlsx');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(exported.raw.rawPayload as unknown as ArrayBuffer);
    let found = false;
    book.worksheets[0]!.eachRow((row) => {
      if (row.getCell(1).value === second!.code) {
        found = true;
        expect(row.getCell(5).type).toBe(ExcelJS.ValueType.String);
        expect(row.getCell(5).value).toBe(`'=${formula}`);
      }
    });
    expect(found).toBe(true);
  });

  it('refuses a Domain Owner who imports documents, and answers 404 to anyone but the creator', async () => {
    const file = csvOf(['ID', 'Title', 'Type'], [['DOC-M208-1', 'Domain owner procedure', 'procedure']]);
    const refused = await upload(bagus, 'isms', 'documents', 'docs.csv', file);
    expect(refused.status).toBe(403);
    expect((await upload(bagus, 'isms', 'applicability', 'soa.csv', csvOf(['ID'], [['A.5.1']]))).status).toBe(403);
    // The template needs ms.read only.
    expect((await bagus.get('/api/v1/ms/isms/imports/templates/documents')).status).toBe(200);

    const mine = await upload(rina, 'isms', 'applicability', 'private.csv', csvOf(['ID', 'Status note'], [['A.5.1', 'Only for rina']]));
    expect(mine.status).toBe(201);
    for (const other of [bagus, maya]) {
      expect((await other.get(`/api/v1/ms/isms/imports/${mine.body.id}`)).status).toBe(404);
      expect((await commit(other, 'isms', mine.body.id)).status).toBe(404);
    }
    expect((await rina.get(`/api/v1/ms/isms/imports/${mine.body.id}`)).status).toBe(200);
  });

  it('checks the permission of the kind again at commit', async () => {
    const manager = await addFixtureUser(db, 'tst', 'm208-manager', { business: [{ ms: 'isms', role: 'ms_manager' }] });
    const client = await sessionFor(full, manager.id, 'tst');
    const checked = await upload(client, 'isms', 'applicability', 'manager.csv', csvOf(['ID', 'Status note'], [['A.5.1', 'From a manager who leaves']]));
    expect(checked.status).toBe(201);
    await inOrg(db, 'tst', (trx) => sql`
      update user_ms_role set role = 'domain_owner' where user_id = ${manager.id} and management_system_id = ${isms}`.execute(trx));
    const refused = await commit(client, 'isms', checked.body.id);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ messageKey: 'imports.permission' });

    // A Risk Owner passes the guard (risk.manage for own risks) and is refused by the service: a new risk needs the
    // permission in full (F.6).
    const owner = await addFixtureUser(db, 'tst', 'm208-risk-owner', { business: [{ ms: 'isms', role: 'risk_owner' }] });
    const riskOwner = await sessionFor(full, owner.id, 'tst');
    const risks = await upload(riskOwner, 'isms', 'risks', 'risks.csv', csvOf(['ID', 'Title', 'Owner'], [['R-M208-RO', 'Own risk', 'm208-risk-owner']]));
    expect(risks.status).toBe(403);
    expect(risks.body).toMatchObject({ messageKey: 'imports.permission' });
  });

  it('registers documents as metadata only through the document command, and leaves existing codes as they are', async () => {
    const [type] = await rowsIn<{ code: string; label: string }>(db, 'tst', sql`
      select l.code, l.label_en as label from ref.lookup_value l join management_system m on m.framework_version_id = l.framework_version_id
       where m.id = ${isms} and l.domain = 'doc_type' order by l.sort_order limit 1`);
    const [existing] = await rowsIn<{ code: string }>(db, 'tst', sql`select doc_code as code from document where deleted_at is null order by doc_code limit 1`);
    const header = [...DOC_HEADER, 'Classification', 'Approver', 'Origin', 'External source', 'External reference', 'Received'];
    const file = await xlsxOf(header, [
      ['DOC-M208-1', 'Remote working procedure', type!.label, '', '', '', '2027-03-01', 'bagus', '', 'isms', 'confidential', 'hendra', '', '', '', ''],
      ['DOC-M208-2', 'Personal Data Protection Law', type!.code, '', '', '', '', '', '', '', '', '', 'External', 'Republic of Indonesia', 'UU 27/2022', new Date('2022-10-17T00:00:00Z')],
      [existing!.code, 'Already there', type!.code, '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['DOC-M208-3', 'Bad origin', type!.code, '', '', '', '', '', '', '', '', '', 'Internal', 'Someone', '', ''],
    ]);
    const checked = await upload(rina, 'isms', 'documents', 'documents.xlsx', file);
    expect(checked.status, checked.text).toBe(201);
    expect(checked.body.results.map((r) => [r.status, r.action])).toEqual([['ok', 'create'], ['ok', 'create'], ['warning', 'unchanged'], ['error', undefined]]);
    expect(checked.body.results[2]!.messages[0]!.en).toBe(`${existing!.code} is already registered: the import leaves this document as it is.`);
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(422);

    const fixed = await xlsxOf(header, [
      ['DOC-M208-1', 'Remote working procedure', type!.label, '', '', '', '2027-03-01', 'bagus', '', 'isms', 'confidential', 'hendra', '', '', '', ''],
      ['DOC-M208-2', 'Personal Data Protection Law', type!.code, '', '', '', '', '', '', '', '', '', 'External', 'Republic of Indonesia', 'UU 27/2022', new Date('2022-10-17T00:00:00Z')],
      [existing!.code, 'Already there', type!.code, '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const { done } = await importFile(full, rina, 'isms', 'documents', 'documents-fixed.xlsx', fixed);
    expect(done).toMatchObject({ status: 'committed', summary: { created: 2, updated: 0, unchanged: 1 } });
    const docs = await rowsIn<{ code: string; status: string; classification: string; owner: string | null; approver: string | null; origin: string; external_source: string | null; received_at: string | null; versions: number; links: number }>(db, 'tst', sql`
      select d.doc_code as code, d.status, d.classification, o.handle as owner, a.handle as approver, d.origin, d.external_source, d.received_at::text,
             (select count(*)::int from document_version v where v.document_id = d.id) as versions,
             (select count(*)::int from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id and l.management_system_id = ${isms}) as links
        from document d left join platform.app_user o on o.id = d.owner_user_id left join platform.app_user a on a.id = d.approver_user_id
       where d.doc_code in ('DOC-M208-1', 'DOC-M208-2') order by d.doc_code`);
    expect(docs).toEqual([
      { code: 'DOC-M208-1', status: 'draft', classification: 'confidential', owner: 'bagus', approver: 'hendra', origin: 'internal', external_source: null, received_at: null, versions: 0, links: 1 },
      { code: 'DOC-M208-2', status: 'draft', classification: 'internal', owner: null, approver: null, origin: 'external', external_source: 'Republic of Indonesia', received_at: '2022-10-17', versions: 0, links: 1 },
    ]);
    expect((await auditOf(db, 'tst', 'document.created')).filter((a) => a.entity_code?.startsWith('DOC-M208')).map((a) => a.actor)).toEqual(['rina', 'rina']);
  });

  it('registers risks through the register command, with BR-17 for a risk without an owner', async () => {
    const profiles = await rowsIn<{ code: string }>(db, 'tst', sql`
      select p.code from ref.risk_profile p join management_system m on m.framework_version_id = p.framework_version_id where m.id = ${isms} order by p.code`);
    const header = ['ID', 'Title', 'Owner', 'Description', 'Risk profile', 'Likelihood', 'Consequence', 'Assessed'];
    const profile = profiles.length === 1 ? '' : profiles[0]!.code;
    const bad = await upload(rina, 'isms', 'risks', 'risks.csv', csvOf(header, [
      ['R-M208-1', 'Supplier outage', 'bagus', 'The hosting supplier fails for a day', profile, '3', '4', '2026-10-01'],
      ['R-M208-2', 'No owner', '', '', profile, '2', '2', ''],
      ['R-M208-3', 'Out of scale', 'maya', '', profile, '99', '1', ''],
    ]));
    expect(bad.status, bad.text).toBe(201);
    expect(bad.body.results.map((r) => r.status)).toEqual(['ok', 'error', 'error']);
    expect(bad.body.results[1]!.messages).toContainEqual({ en: 'A risk needs an owner.', id: 'Risiko memerlukan pemilik.' });
    expect(bad.body.results[2]!.messages[0]!.en).toMatch(/^Likelihood: 99 is outside the scale 1 to \d+ of profile /);

    const { done } = await importFile(full, rina, 'isms', 'risks', 'risks-ok.csv', csvOf(header, [['R-M208-1', 'Supplier outage', 'bagus', 'The hosting supplier fails for a day', profile, '3', '4', '2026-10-01']]));
    expect(done).toMatchObject({ status: 'committed', summary: { created: 1 } });
    const [risk] = await rowsIn<{ title: string; owner: string; likelihood: number; consequence: number; linked: number }>(db, 'tst', sql`
      select r.title, o.handle as owner, r.likelihood, r.consequence,
             (select count(*)::int from entity_ms_link l where l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${isms}) as linked
        from risk r join platform.app_user o on o.id = r.owner_user_id where r.code = 'R-M208-1' and r.deleted_at is null`);
    expect(risk).toEqual({ title: 'Supplier outage', owner: 'bagus', likelihood: 3, consequence: 4, linked: 1 });
  });

  it('lets a Domain Owner import evidence they own, and only that', async () => {
    const [frequency] = await rowsIn<{ code: string }>(db, 'tst', sql`
      select f.code from ref.evidence_frequency_rule f join management_system m on m.framework_version_id = f.framework_version_id
       where m.id = ${isms} order by f.sort_order limit 1`);
    const header = ['ID', 'Title', 'Owner', 'Frequency', 'Classification', 'Controls and clauses'];
    const checked = await upload(bagus, 'isms', 'evidence', 'evidence.csv', csvOf(header, [
      ['EV-M208-1', 'Firewall rule review', '', frequency!.code, '', 'A.8.20, Cl. 9.1'],
      ['EV-M208-2', 'Someone else', 'rina', frequency!.code, 'internal', 'A.8.20'],
      ['EV-M208-3', 'Unknown target', 'bagus', frequency!.code, '', 'A.99.1'],
    ]));
    expect(checked.status, checked.text).toBe(201);
    expect(checked.body.results.map((r) => r.status)).toEqual(['ok', 'error', 'error']);
    expect(checked.body.results[1]!.messages[0]!.en).toBe('Owner: you can add evidence only with yourself as the owner.');
    expect(checked.body.results[2]!.messages[0]!.en).toBe('Controls and clauses: A.99.1 has no entry in this system.');

    const { done } = await importFile(full, bagus, 'isms', 'evidence', 'evidence-ok.csv', csvOf(header, [['EV-M208-1', 'Firewall rule review', '', frequency!.code, '', 'A.8.20, Cl. 9.1']]));
    expect(done).toMatchObject({ status: 'committed', summary: { created: 1 } });
    const [evidence] = await rowsIn<{ owner: string; targets: number }>(db, 'tst', sql`
      select o.handle as owner, (select count(*)::int from evidence_target t where t.evidence_id = e.id and t.deleted_at is null) as targets
        from evidence e join platform.app_user o on o.id = e.owner_user_id where e.evidence_code = 'EV-M208-1'`);
    expect(evidence).toEqual({ owner: 'bagus', targets: 2 });
  });

  it('fails the whole import when an entry changed after the check, and keeps nothing of it', async () => {
    const [a, b] = (await controls()).slice(10, 12);
    const before = await entry(a!.code);
    const checked = await upload(rina, 'isms', 'applicability', 'stale.csv', csvOf(['ID', 'Status note'], [[a!.code, 'Stale one'], [b!.code, 'Stale two']]));
    expect(checked.status).toBe(201);
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(202);
    await inOrg(db, 'tst', (trx) => sql`update applicability_entry set status_note = 'Changed meanwhile', updated_at = now() + interval '1 second' where id = ${b!.id}`.execute(trx));
    const [result] = await runImportJobs(full);
    expect(result).toMatchObject({ status: 'failed' });
    const failed = await rina.get<ImportRun>(`/api/v1/ms/isms/imports/${checked.body.id}`);
    expect(ImportRun.safeParse(failed.body).success).toBe(true);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.failure!.en).toBe(`Row 2 (${b!.code}): ${b!.code} changed after the file was checked. Check the file again to import it.`);
    expect(failed.body.results[1]).toMatchObject({ row: 2, status: 'error' });
    expect(failed.body.results[1]).not.toHaveProperty('action');
    expect(await entry(a!.code)).toEqual(before);
    expect((await entry(b!.code)).note).toBe('Changed meanwhile');
    expect((await notificationsOf(db, 'tst', 'rina', 'import_finished'))[0]!.title_en).toBe('Import failed: Controls and requirements');
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(409);
  });

  it('lets other audited writes of the organisation go on while a commit applies its rows', async () => {
    // The commit's transaction keeps its audit entries until every row is in (ImportHold): the organisation's audit
    // chain lock (`chain_hash`) is taken only by the commit's last statements, so writes of other people neither wait
    // for the rows nor run into the statement timeout of the application role.
    const [a, b] = (await controls()).slice(20, 22);
    const checked = await upload(rina, 'isms', 'applicability', 'held.csv', csvOf(['ID', 'Status note'], [[a!.code, 'Held one'], [b!.code, 'Held two']]));
    expect(checked.status, checked.text).toBe(201);
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(202);
    const { held: other, results: [result] } = await withCommitHeld(() => otherAuditedWrite('2s'));
    expect(other.ms).toBeLessThan(2000);
    expect(result).toMatchObject({ status: 'committed', summary: { updated: 2 } });
    // The other write came first in the chain; the commit's entries follow it, and the chain holds.
    const [{ first, n }] = await rowsIn<{ first: string; n: number }>(db, 'tst', sql`
      select min(t.seq)::text as first, count(*)::int as n from audit_trail t
       where t.action = 'applicability.updated' and t.entity_id in (${a!.id}, ${b!.id})
         and t.xmin = (select e.xmin from applicability_entry e where e.id = ${a!.id})`) as [{ first: string; n: number }];
    expect(n).toBe(2);
    expect(BigInt(first)).toBeGreaterThan(BigInt(other.seq));
    expect(await firstBrokenSeq()).toBeNull();
    expect((await entry(a!.code)).note).toBe('Held one');
    expect((await entry(b!.code)).note).toBe('Held two');
  });

  it('answers a second commit sent while the worker applies the import with 409 at once', async () => {
    // The worker's transaction locks the import's row until the commit ends; `imports.commit` locks it with NOWAIT,
    // so another tab, a retry or an API client gets 409 `imports.not_waiting` without waiting for the rows (a wait
    // longer than the 30-second statement timeout of the application role would end in a server error).
    const [a, b] = (await controls()).slice(24, 26);
    const checked = await upload(rina, 'isms', 'applicability', 'twice.csv', csvOf(['ID', 'Status note'], [[a!.code, 'Twice one'], [b!.code, 'Twice two']]));
    expect(checked.status, checked.text).toBe(201);
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(202);
    const { held: second, results: [result] } = await withCommitHeld(async () => {
      const started = Date.now();
      const reply = await within(commit(rina, 'isms', checked.body.id), 10_000, 'The second commit');
      const seen = await within(rina.get<ImportRun>(`/api/v1/ms/isms/imports/${checked.body.id}`), 10_000, 'Reading the import');
      return { reply, ms: Date.now() - started, status: seen.body.status };
    });
    expect(second.reply.status).toBe(409);
    expect(second.reply.body).toMatchObject({
      messageKey: 'imports.not_waiting',
      messages: { en: 'This import is being committed.', id: 'Impor ini sedang diproses.' },
    });
    expect(second.ms).toBeLessThan(5000);
    expect(second.status).toBe('committing');
    // The refused request changed nothing: the commit goes on and applies both rows, once.
    expect(result).toMatchObject({ status: 'committed', summary: { updated: 2 } });
    expect(await runImportJobs(full)).toEqual([]);
    expect((await entry(a!.code)).note).toBe('Twice one');
    expect((await entry(b!.code)).note).toBe('Twice two');
    expect((await auditOf(db, 'tst', 'import.committed')).filter((e) => e.entity_id === checked.body.id)).toHaveLength(1);
  });

  it('refuses files it cannot read: a header that is not the template, too many rows, another format', async () => {
    const header = await upload(rina, 'isms', 'applicability', 'wrong.csv', csvOf(['Control', 'Comment'], [['A.5.1', 'x']]));
    expect(header.status).toBe(422);
    expect(header.body).toMatchObject({ messageKey: 'imports.header_mismatch' });
    expect((header.body as unknown as { messages: { en: string } }).messages.en).toContain('Columns that are not in the template: Control, Comment');
    const missing = await upload(rina, 'isms', 'documents', 'docs.csv', csvOf(['Title'], [['No code']]));
    expect(missing.status).toBe(422);
    expect((missing.body as unknown as { messages: { en: string } }).messages.en).toContain('Required columns missing: ID');

    const rows = Array.from({ length: 5001 }, (_, i) => [`R-${i}`]);
    const tooMany = await upload(rina, 'isms', 'risks', 'big.csv', csvOf(['ID'], rows));
    expect(tooMany.status).toBe(413);
    expect(tooMany.body).toMatchObject({ messageKey: 'imports.too_many_rows' });

    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    expect((await upload(rina, 'isms', 'risks', 'old.xls', xls)).body).toMatchObject({ messageKey: 'imports.unsupported_file' });
    expect((await upload(rina, 'isms', 'risks', 'broken.xlsx', Buffer.from('PK\u0003\u0004not a zip'))).status).toBe(422);
    expect((await upload(rina, 'isms', 'risks', 'empty.csv', Buffer.alloc(0))).body).toMatchObject({ messageKey: 'imports.empty_file' });
    const big = await upload(rina, 'isms', 'risks', 'huge.csv', Buffer.alloc(5 * 1024 * 1024 + 10, 0x41));
    expect(big.status).toBe(413);
  });

  it(`measures a file of 5,000 rows: the check and the commit of 5,000 new risks in one transaction`, async () => {
    const header = ['ID', 'Title', 'Owner', 'Likelihood', 'Consequence'];
    const profiles = await rowsIn<{ code: string }>(db, 'tst', sql`
      select p.code from ref.risk_profile p join management_system m on m.framework_version_id = p.framework_version_id where m.id = ${isms}`);
    const withProfile = profiles.length === 1 ? header : [...header, 'Risk profile'];
    const rows = Array.from({ length: 5000 }, (_, i) => {
      const row = [`R-BULK-${String(i + 1).padStart(4, '0')}`, `Bulk risk ${i + 1}`, ['bagus', 'maya', 'rina'][i % 3]!, String((i % 5) + 1), String(((i + 2) % 5) + 1)];
      return profiles.length === 1 ? row : [...row, profiles[0]!.code];
    });
    const file = csvOf(withProfile, rows);
    const startCheck = Date.now();
    const checked = await upload(rina, 'isms', 'risks', 'bulk-risks.csv', file);
    const checkMs = Date.now() - startCheck;
    expect(checked.status, checked.text.slice(0, 300)).toBe(201);
    expect(checked.body.counts).toEqual({ ok: 5000, warning: 0, error: 0 });
    expect((await commit(rina, 'isms', checked.body.id)).status).toBe(202);
    const startCommit = Date.now();
    let committing = true;
    const running = runImportJobs(full).finally(() => {
      committing = false;
    });
    // While the commit runs, another audited write of the organisation every 250 ms, with the 30-second statement
    // timeout of the application role in Compose and SaaS installs: none may fail, and none may wait long.
    const waits: number[] = [];
    while (committing) {
      waits.push((await otherAuditedWrite('30s')).ms);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const [result] = await running;
    const commitMs = Date.now() - startCommit;
    expect(result).toMatchObject({ status: 'committed', summary: { created: 5000 } });
    const [{ n, tx }] = await rowsIn<{ n: number; tx: number }>(db, 'tst', sql`
      select count(*)::int as n, count(distinct xmin::text)::int as tx from risk where code like 'R-BULK-%' and deleted_at is null`) as [{ n: number; tx: number }];
    expect([n, tx]).toEqual([5000, 1]);
    const longest = Math.max(...waits);
    expect(waits.length).toBeGreaterThan(1);
    expect(longest).toBeLessThan(10_000);
    expect(await firstBrokenSeq()).toBeNull();
    console.info(`M2-08 5,000-row import: check ${checkMs} ms, commit ${commitMs} ms; ${waits.length} other audited writes meanwhile, the longest ${longest} ms`);
  }, 600_000);

  it('keeps the import in the organisation and the system of the request', async () => {
    const mine = await upload(rina, 'isms', 'applicability', 'scoped.csv', csvOf(['ID', 'Status note'], [['A.5.1', 'Scoped']]));
    const ndtRina = await demoSession(full, db, 'rina', 'ndt');
    expect((await ndtRina.get(`/api/v1/ms/isms/imports/${mine.body.id}`)).status).toBe(404);
    expect((await commit(ndtRina, 'isms', mine.body.id)).status).toBe(404);
    const [row] = await rowsIn<{ organization_id: string }>(db, 'tst', sql`select organization_id from import_run where id = ${mine.body.id}`);
    expect(row!.organization_id).toBe(TST);
  });
});
