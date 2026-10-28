// Area `imports` (Milestone 2 D.1, D2-13, built by M2-08): bulk import of applicability entries, documents, risks and
// evidence. One file per import: an upload checks every row (dry run) and stores an `import_run`; the commit applies
// every row or none through the existing command services, in the worker (`import.run`). The import kind is a path
// member because the guard cannot read a multipart body before the handler (D.1). `imports.get` and
// `imports.commit` answer 404 to anyone but the creator, and the commit checks the kind's permission again.
//
// M2-08 (schemas only, R-14): every row of the file is in `results` with its business id and what the commit does with
// it (`action`), so the screen lists the whole file and filters the rows with errors; `progress` follows the commit,
// `summary` and `changed` describe a committed import and `failure` says why a commit failed.
import { z } from 'zod';
import { ImportKind, ImportRunStatus, Lang } from '../enums.js';
import { BinaryBody, CommandResult, Instant, Messages, MsId, MsRecordParams, Uuid, defineRoute, named } from './common.js';
import type { PermissionByMember, RouteDef } from './common.js';

/** Largest import file (Milestone 2 I: 5 MB and 5,000 rows). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** Most data rows of one import file. */
export const MAX_IMPORT_ROWS = 5000;

/** Media type of the XLSX templates. */
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const ImportKindParams = named('ImportKindParams', z.strictObject({ ms: MsId, kind: ImportKind }), 'Path parameters {ms} and {kind}: the system and the import kind', {
  valid: [{ ms: 'isms', kind: 'applicability' }],
  invalid: [{ ms: 'isms', kind: 'users' }, { ms: 'isms' }],
});
export type ImportKindParams = z.infer<typeof ImportKindParams>;

export const ImportTemplateQuery = named(
  'ImportTemplateQuery',
  z.strictObject({ lang: Lang.optional() }),
  'Query of an import template: the language of its help sheet (the app language); without it, Accept-Language decides',
  { valid: [{}, { lang: 'id' }], invalid: [{ lang: 'fr' }, { lang: 'id', format: 'csv' }] },
);
export type ImportTemplateQuery = z.infer<typeof ImportTemplateQuery>;

export const ImportUploadForm = named(
  'ImportUploadForm',
  z.object({ file: BinaryBody }),
  'POST /ms/{ms}/imports/{kind} multipart form: the CSV or XLSX file in field file (at most 5 MB and 5,000 rows)',
  { valid: [{ file: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }], invalid: [{}, { file: 'not bytes' }] },
);

export const IMPORT_ROW_STATUSES = ['ok', 'error', 'warning'] as const;
export const ImportRowStatus = z.enum(IMPORT_ROW_STATUSES).meta({ id: 'ImportRowStatus', description: 'Result of one row of an import dry run' });
export type ImportRowStatus = z.infer<typeof ImportRowStatus>;

/** What the commit does with a row: a new record, a change of an existing one (applicability only) or nothing. */
export const IMPORT_ROW_ACTIONS = ['create', 'update', 'unchanged'] as const;
export const ImportRowAction = z.enum(IMPORT_ROW_ACTIONS).meta({ id: 'ImportRowAction', description: 'What the commit does with a row of an import' });
export type ImportRowAction = z.infer<typeof ImportRowAction>;

export const ImportRowResult = named(
  'ImportRowResult',
  z.object({
    row: z.int().min(1),
    status: ImportRowStatus,
    messages: z.array(Messages),
    /** Business id of the row (control or clause, document, risk or evidence code), when the row names one. */
    code: z.string().max(60).optional(),
    /** Left out for a row with an error. */
    action: ImportRowAction.optional(),
  }),
  'Result of one data row (row 1 is the first row after the header): its status, the messages, its business id and what the commit does with it',
  {
    valid: [
      { row: 1, status: 'ok', messages: [], code: 'A.5.1', action: 'update' },
      { row: 7, status: 'error', messages: [{ en: 'Unknown owner bagus.p', id: 'Pemilik bagus.p tidak dikenal' }], code: 'A.5.7' },
      { row: 9, status: 'ok', messages: [] },
    ],
    invalid: [{ row: 0, status: 'ok', messages: [] }, { row: 2, status: 'fine', messages: [] }, { row: 3, status: 'ok', messages: [], action: 'delete' }],
  },
);
export type ImportRowResult = z.infer<typeof ImportRowResult>;

const EXAMPLE_RUN = {
  id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', kind: 'applicability', fileName: 'soa-2026.xlsx', status: 'validated', rowCount: 93,
  counts: { ok: 92, warning: 1, error: 0 },
  results: [
    { row: 1, status: 'ok', messages: [], code: 'A.5.1', action: 'update' },
    { row: 12, status: 'warning', messages: [{ en: 'Justification looks like filler text', id: 'Justifikasi tampak seperti teks pengisi' }], code: 'A.5.12', action: 'update' },
  ],
  createdAt: '2026-10-28T03:00:00Z', committedAt: null, taskId: null,
} as const;

const EXAMPLE_COMMITTED = {
  ...EXAMPLE_RUN, status: 'committed', committedAt: '2026-10-28T03:05:00Z', taskId: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', progress: 100,
  summary: { created: 0, updated: 90, unchanged: 3 }, changed: ['isms'],
} as const;

export const ImportRun = named(
  'ImportRun',
  z.object({
    id: Uuid,
    kind: ImportKind,
    fileName: z.string(),
    status: ImportRunStatus,
    rowCount: z.int().min(0),
    counts: z.object({ ok: z.int().min(0), warning: z.int().min(0), error: z.int().min(0) }),
    /** Every data row of the file, in file order, with its status, messages, business id and action. */
    results: z.array(ImportRowResult),
    createdAt: Instant,
    committedAt: Instant.nullable(),
    taskId: Uuid.nullable(),
    /** Share of the rows the commit has applied (0 to 100), while it runs and after it ended. */
    progress: z.int().min(0).max(100).optional(),
    /** Records the commit created, changed and left as they were (a committed import). */
    summary: z.object({ created: z.int().min(0), updated: z.int().min(0), unchanged: z.int().min(0) }).optional(),
    /** Systems whose data the commit changed (a committed import), for the screens to load again. */
    changed: z.array(MsId).optional(),
    /** Why the commit failed (a failed import); the row that failed carries the same message in `results`. */
    failure: Messages.optional(),
  }),
  'An import of one file: its state, the results of the dry run for every row, and the outcome of the commit (Milestone 2 D.1)',
  {
    valid: [
      EXAMPLE_RUN,
      EXAMPLE_COMMITTED,
      { ...EXAMPLE_RUN, status: 'failed', taskId: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', progress: 40, failure: { en: 'Row 12: A.5.12 changed after the file was checked', id: 'Baris 12: A.5.12 berubah setelah berkas diperiksa' } },
    ],
    invalid: [{ ...EXAMPLE_RUN, status: 'done' }, { ...EXAMPLE_RUN, kind: 'users' }, { ...EXAMPLE_COMMITTED, progress: 101 }, { ...EXAMPLE_COMMITTED, changed: ['ISMS'] }],
  },
);
export type ImportRun = z.infer<typeof ImportRun>;

/** Milestone 2 D.1: the permission of the import kind; `*` covers `evidence`, the kind without a case of its own. */
const importPermission = {
  source: 'path',
  member: 'kind',
  cases: {
    'applicability': { permission: 'applicability.manage', scope: 'ms' },
    'documents': { permission: 'document.manage', scope: 'ms' },
    'risks': { permission: 'risk.manage', scope: 'ms' },
    '*': { permission: 'evidence.manage', scope: 'ms' },
  },
} as const satisfies PermissionByMember;

const m2 = { owner: 'M2-08' as const, auth: 'session' as const, msSource: 'path' as const };

export const importsTemplatesRoute = defineRoute({
  ...m2, id: 'imports.templates', method: 'GET', path: '/api/v1/ms/:ms/imports/templates/:kind',
  summary: 'XLSX template of an import kind, with the header row of the matching export and an Allowed values sheet in the language of lang (else of Accept-Language)',
  permission: 'ms.read', scope: 'ms', params: ImportKindParams, query: ImportTemplateQuery, response: BinaryBody, responseType: XLSX_MEDIA_TYPE, file: true, errors: [404],
});
export const importsCreateRoute = defineRoute({
  ...m2, id: 'imports.create', method: 'POST', path: '/api/v1/ms/:ms/imports/:kind',
  summary: 'Upload a CSV or XLSX file and check every row (dry run): the import id and the row results (audited import.validated); 409 when the same file was already imported, 413 above 5 MB or 5,000 rows, 422 for a file that cannot be read or a header that does not match the template',
  permissionBy: importPermission, params: ImportKindParams, body: ImportUploadForm, requestType: 'multipart/form-data',
  response: ImportRun, status: 201, errors: [404, 409, 413, 422],
});
export const importsGetRoute = defineRoute({
  ...m2, id: 'imports.get', method: 'GET', path: '/api/v1/ms/:ms/imports/:id',
  summary: 'State and row results of an import (its creator only)', permission: 'ms.read', scope: 'ms',
  params: MsRecordParams, response: ImportRun, errors: [404],
});
export const importsCommitRoute = defineRoute({
  ...m2, id: 'imports.commit', method: 'POST', path: '/api/v1/ms/:ms/imports/:id/commit',
  summary: 'Apply every row of a checked import in one transaction in the worker (its creator only; the kind permission is checked again): 202 with the task id; 409 when the import is not waiting for a commit or the same file was already imported, 422 while a row has an error',
  permission: 'ms.read', scope: 'ms', params: MsRecordParams, response: CommandResult, status: 202, errors: [404, 409, 422],
});

export const routes: RouteDef[] = [importsTemplatesRoute, importsCreateRoute, importsGetRoute, importsCommitRoute];
