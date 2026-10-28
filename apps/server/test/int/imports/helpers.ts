// Helpers of the bulk import tests (Milestone 2 D.1, D2-13, M2-08): the whole api application of the contract
// harness (so the imports module is wired as in production), multipart uploads, XLSX and CSV files built with exceljs
// and csv-stringify, and the commit run through the `import.run` job of the application.
import { randomBytes } from 'node:crypto';
import type { CommandResult, ImportKind, ImportRun } from '@mscd/shared';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { ImportRunJob, type ImportRunResult } from '../../../src/modules/imports/import-run.job';
import type { TestDatabase } from '../../setup/test-db';
import { ORG_IDS, rowsIn, type Client, type DemoOrg, type FullApp, type Reply } from '../contract/harness';

export {
  ORG_IDS, addFixtureUser, createFullApp, demoSession, inOrg, msIdOf, rowsIn, sessionFor, userIdOf, type Client, type DemoOrg, type FullApp, type Reply,
} from '../contract/harness';

/** English headers of the SoA export (exports/export-content.service.ts `soaColumns`). */
export const SOA_HEADER = [
  'ID', 'Title', 'Theme', 'Applicable', 'Justification', 'Status', 'Owner', 'Implementing document', 'Frequency', 'Last evidence', 'Freshness', 'Integrity',
];

/** English headers of the document register export (`docColumns`). */
export const DOC_HEADER = ['ID', 'Title', 'Type', 'Version', 'Status', 'Approved', 'Next review', 'Owner', 'Shared', 'System'];

/** A cell of a test workbook: a value, or a formula with its cached result. */
export type TestCell = string | number | boolean | Date | null | { formula: string; result?: string | number };

/** An XLSX workbook with one sheet: the header row and the data rows (formula cells written as formulas). */
export async function xlsxOf(header: readonly string[], rows: readonly (readonly TestCell[])[], options: { help?: boolean; sheet?: string } = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheet ?? 'Sheet1');
  sheet.addRow([...header]);
  for (const row of rows) sheet.addRow(row.map((c) => (c && typeof c === 'object' && !(c instanceof Date) ? { formula: c.formula, result: c.result } : c)) as ExcelJS.CellValue[]);
  if (options.help) workbook.addWorksheet('Allowed values').addRow(['Column', 'Required', 'What it takes']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A UTF-8 CSV file with a byte order mark (as the exports write it). */
export function csvOf(header: readonly string[], rows: readonly (readonly (string | number)[])[], delimiter = ','): Buffer {
  const text = stringify([header, ...rows].map((r) => r.map((c) => String(c))), { delimiter, record_delimiter: 'windows' });
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

/** A multipart body with one file part. */
export function multipart(fileName: string, bytes: Buffer, field = 'file'): { body: Buffer; headers: Record<string, string> } {
  const boundary = `m208${randomBytes(10).toString('hex')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** `POST /ms/{ms}/imports/{kind}` with one file. */
export function upload(client: Client, ms: string, kind: ImportKind, fileName: string, bytes: Buffer): Promise<Reply<ImportRun>> {
  const form = multipart(fileName, bytes);
  return client.request<ImportRun>('POST', `/api/v1/ms/${ms}/imports/${kind}`, { body: form.body, headers: form.headers });
}

/** `POST /ms/{ms}/imports/{id}/commit`. */
export function commit(client: Client, ms: string, id: string): Promise<Reply<CommandResult>> {
  return client.post<CommandResult>(`/api/v1/ms/${ms}/imports/${id}/commit`);
}

const ran = new WeakMap<FullApp, Set<string>>();

/**
 * Runs the `import.run` jobs the commits queued since the last call, through the job of the application, oldest first.
 * The api application has no worker, so the queued jobs stay in the in-memory queue; the ones run here are remembered.
 */
export async function runImportJobs(full: FullApp): Promise<ImportRunResult[]> {
  const queue = full.get<InMemoryJobQueue>(JOB_QUEUE);
  const job = full.get<ImportRunJob>(ImportRunJob);
  const done = ran.get(full) ?? new Set<string>();
  ran.set(full, done);
  const out: ImportRunResult[] = [];
  for (const waiting of queue.waitingJobs('import.run')) {
    if (done.has(waiting.id)) continue;
    done.add(waiting.id);
    const run = waiting as unknown as { env: { orgId: string; requestId?: string; payload: { importId: string; taskId: string } } };
    out.push(await job.run(run.env.orgId, run.env.payload.importId, run.env.payload.taskId, run.env.requestId));
  }
  return out;
}

/** Upload, commit and run the job; the import as `imports.get` shows it afterwards. */
export async function importFile(full: FullApp, client: Client, ms: string, kind: ImportKind, fileName: string, bytes: Buffer): Promise<{ checked: ImportRun; done: ImportRun }> {
  const checked = await upload(client, ms, kind, fileName, bytes);
  if (checked.status !== 201) throw new Error(`upload answered ${checked.status}: ${checked.text}`);
  const committed = await commit(client, ms, checked.body.id);
  if (committed.status !== 202) throw new Error(`commit answered ${committed.status}: ${committed.text}`);
  await runImportJobs(full);
  const done = await client.get<ImportRun>(`/api/v1/ms/${ms}/imports/${checked.body.id}`);
  return { checked: checked.body, done: done.body };
}

/** Audit entries of an action in an organisation, oldest first, with the actor's handle. */
export function auditOf(db: TestDatabase, org: DemoOrg, action: string) {
  return rowsIn<{ entity_type: string | null; entity_id: string | null; entity_code: string | null; actor: string | null; after: Record<string, unknown> | null }>(
    db,
    org,
    sql`select a.entity_type, a.entity_id, a.entity_code, u.handle as actor, a.after_data as after
          from audit_trail a left join platform.app_user u on u.id = a.actor_user_id
         where a.action = ${action} order by a.seq`,
  );
}

/** Notifications of a user of one kind, newest first. */
export function notificationsOf(db: TestDatabase, org: DemoOrg, handle: string, kind: string) {
  return rowsIn<{ title_en: string; body_en: string; title_id: string }>(db, org, sql`
    select n.title_en, n.body_en, n.title_id from notification n join platform.app_user u on u.id = n.recipient_user_id
     where u.handle = ${handle} and n.kind = ${kind} order by n.created_at desc, n.id`);
}

export const TST = ORG_IDS.tst;
