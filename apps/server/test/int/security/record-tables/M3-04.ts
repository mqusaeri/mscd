// Record tables of the routes of M3-04: requests from one person (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-04; merged by ../record-tables.ts. Written by M3-01 with the tables of the stubs.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['privacy_check'],
  idTables: { 'privacy-checks.mentions': 'privacy_check', 'privacy-checks.done': 'privacy_check' },
  reads: {
    'privacy-requests.list': null,
    'privacy-requests.get': 'privacy_request',
    'privacy-checks.list': null,
    'privacy-checks.mentions': 'privacy_check',
    'me.privacy-requests.list': null,
  },
};
