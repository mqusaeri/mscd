// Record tables of the routes of M2-S10: entitlements and plan presets (docs/platform/MILESTONE-2.md F).
// Owned by M2-S10; merged by ../record-tables.ts.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'ops.entitlements.get': null, 'ops.plans.list': null },
};
