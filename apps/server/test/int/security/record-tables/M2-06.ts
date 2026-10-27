// Record tables of the routes of M2-06: organisation settings, onboarding, account security and the operator organisation list (docs/platform/MILESTONE-2.md F).
// Owned by M2-06; merged by ../record-tables.ts.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'admin.organization.get': null, 'admin.onboarding': null, 'me.security': null, 'ops.organizations.list': null },
};
