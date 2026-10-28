// Record tables of the routes of M2-S09: the organisation detail and status history of the operator (docs/platform/MILESTONE-2.md F).
// Owned by M2-S09; merged by ../record-tables.ts.
//
// No record table: both GET routes read platform tables (`platform.organization`, `platform.organization_status_event`,
// `platform.entitlement`, `platform.verified_domain`, `platform.session`) for the platform operator, who holds no
// membership, and the status change writes platform tables only. The owner-scope sweep has no tenant record to check.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'ops.organizations.get': null, 'ops.organizations.events': null },
};
