// Record tables of the routes of M2-S11: email domains (docs/platform/MILESTONE-2.md F).
// Owned by M2-S11; merged by ../record-tables.ts. The routes name an organisation by its slug (`{org}`) and a domain by
// its name, no record id, and they are platform routes of the operator, so they add no table to the record sweeps.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'ops.domains.list': null },
};
