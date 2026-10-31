// Record tables of the routes of M3-06: retention and disposal review (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-06; merged by ../record-tables.ts. Written by M3-01 with the tables of the stubs; kept by M3-06 (the
// reads name no record id: every list is of the system in the path).
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['retention_rule', 'retention_review', 'retention_hold'],
  idTables: {
    'retention.reviews.approve': 'retention_review',
    'retention.reviews.reject': 'retention_review',
    'retention.reviews.file-removed': 'retention_review',
    'retention.holds.release': 'retention_hold',
  },
  reads: { 'retention.rules.list': null, 'retention.reviews.list': null, 'retention.register': null, 'retention.holds.list': null },
};
