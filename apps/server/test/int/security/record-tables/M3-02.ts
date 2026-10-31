// Record tables of the routes of M3-02: organisation export (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-02; merged by ../record-tables.ts. Written by M3-01 with the tables of the stubs.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: {
    'exports.organization.list': null,
    'exports.organization.get': 'platform.organization_export',
    'exports.organization.manifest': 'platform.organization_export',
    'exports.organization.download': 'platform.organization_export',
    'ops.exports.list': null,
  },
};
