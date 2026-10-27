// Area `imports` (Milestone 2 D.1, D2-13, built by M2-08): bulk import of applicability entries, documents, risks and
// evidence. One file per import: an upload checks every row (dry run) and stores an `import_run`; the commit applies
// every row or none through the existing command services, in the worker (`import.run`). The import kind is a path
// member because the guard cannot read a multipart body before the handler (D.1). `imports.get` and
// `imports.commit` answer 404 to anyone but the creator, and the commit checks the kind's permission again.
import { z } from 'zod';
import { ImportKind, ImportRunStatus } from '../enums.js';
import { BinaryBody, CommandResult, Instant, MsId, MsRecordParams, Uuid, defineRoute, named } from './common.js';
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

export const ImportUploadForm = named(
  'ImportUploadForm',
  z.object({ file: BinaryBody }),
  'POST /ms/{ms}/imports/{kind} multipart form: the CSV or XLSX file in field file (at most 5 MB and 5,000 rows)',
  { valid: [{ file: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }], invalid: [{}, { file: 'not bytes' }] },
);

export const IMPORT_ROW_STATUSES = ['ok', 'error', 'warning'] as const;
export const ImportRowStatus = z.enum(IMPORT_ROW_STATUSES).meta({ id: 'ImportRowStatus', description: 'Result of one row of an import dry run' });
export type ImportRowStatus = z.infer<typeof ImportRowStatus>;

export const ImportRowResult = named(
  'ImportRowResult',
  z.object({ row: z.int().min(1), status: ImportRowStatus, messages: z.array(z.object({ en: z.string(), id: z.string() })) }),
  'Result of one data row (row 1 is the first row after the header)',
  {
    valid: [{ row: 1, status: 'ok', messages: [] }, { row: 7, status: 'error', messages: [{ en: 'Unknown owner bagus.p', id: 'Pemilik bagus.p tidak dikenal' }] }],
    invalid: [{ row: 0, status: 'ok', messages: [] }, { row: 2, status: 'fine', messages: [] }],
  },
);
export type ImportRowResult = z.infer<typeof ImportRowResult>;

const EXAMPLE_RUN = {
  id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', kind: 'applicability', fileName: 'soa-2026.xlsx', status: 'validated', rowCount: 93,
  counts: { ok: 92, warning: 1, error: 0 }, results: [{ row: 12, status: 'warning', messages: [{ en: 'Justification looks like filler text', id: 'Justifikasi tampak seperti teks pengisi' }] }],
  createdAt: '2026-10-28T03:00:00Z', committedAt: null, taskId: null,
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
    /** Rows with an error or a warning; rows without a message are counted only. */
    results: z.array(ImportRowResult),
    createdAt: Instant,
    committedAt: Instant.nullable(),
    taskId: Uuid.nullable(),
  }),
  'An import of one file: its state and the results of the dry run (Milestone 2 D.1)',
  {
    valid: [EXAMPLE_RUN, { ...EXAMPLE_RUN, status: 'committed', committedAt: '2026-10-28T03:05:00Z', taskId: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f' }],
    invalid: [{ ...EXAMPLE_RUN, status: 'done' }, { ...EXAMPLE_RUN, kind: 'users' }],
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
  summary: 'XLSX template of an import kind, with the header row of the matching export and an Allowed values sheet',
  permission: 'ms.read', scope: 'ms', params: ImportKindParams, response: BinaryBody, responseType: XLSX_MEDIA_TYPE, file: true, errors: [404],
});
export const importsCreateRoute = defineRoute({
  ...m2, id: 'imports.create', method: 'POST', path: '/api/v1/ms/:ms/imports/:kind',
  summary: 'Upload a CSV or XLSX file and check every row (dry run): the import id and the row results (audited import.validated)',
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
  summary: 'Apply every row of a checked import in one transaction in the worker (its creator only; the kind permission is checked again): 202 with the task id',
  permission: 'ms.read', scope: 'ms', params: MsRecordParams, response: CommandResult, status: 202, errors: [404, 409, 422],
});

export const routes: RouteDef[] = [importsTemplatesRoute, importsCreateRoute, importsGetRoute, importsCommitRoute];
