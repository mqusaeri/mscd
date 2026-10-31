// Record tables of the routes of M3-05: read confirmation of policies (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-05; merged by ../record-tables.ts. Written by M3-01 with the tables of the stubs.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['acknowledgement_request'],
  idTables: {
    'acknowledgement-requests.get': 'acknowledgement_request',
    'acknowledgement-requests.remind': 'acknowledgement_request',
    'acknowledgement-requests.close': 'acknowledgement_request',
    'acknowledgement-requests.export': 'acknowledgement_request',
  },
  reads: {
    'acknowledgement-requests.list': null,
    'acknowledgement-requests.get': 'acknowledgement_request',
    'acknowledgement-requests.export': 'acknowledgement_request',
    'me.acknowledgements': null,
  },
};
