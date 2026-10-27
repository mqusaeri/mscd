// Record tables of the routes of M2-07: targets, freshness thresholds, documented information, document versions, holdings and management review changes (docs/platform/MILESTONE-2.md F).
// Owned by M2-07; merged by ../record-tables.ts.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: { 'documents.versions.list': 'document', 'management-reviews.update': 'management_review' },
  reads: { 'applicability.targets': null, 'freshness.thresholds.get': null, 'documented-info.list': null, 'documents.versions.list': 'document', 'records.holdings': null, 'admin.users.holdings': null },
};
