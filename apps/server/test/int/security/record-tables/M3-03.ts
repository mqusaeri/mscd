// Record tables of the routes of M3-03: end of contract and verified deletion (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-03; merged by ../record-tables.ts. The deletion routes are platform routes of the operator: they read
// `platform.organization_deletion` by the organisation slug, never a tenant record by id, so they add no direct or
// `{id}` table; the two GET routes are listed as reads without a tenant table.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'ops.deletion.get': null, 'ops.deletion.certificate': null },
};
