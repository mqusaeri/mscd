// Record tables of the routes of M2-05: certification cycles and the internal audit programme (docs/platform/MILESTONE-2.md F).
// Owned by M2-05; merged by ../record-tables.ts.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['certification_cycle'],
  idTables: { 'ms.cycles.transition': 'certification_cycle' },
  reads: { 'ms.cycles.list': null, 'internal-audit.programme': null },
};
