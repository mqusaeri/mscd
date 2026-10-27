// Record tables of the routes of M2-08: bulk import (docs/platform/MILESTONE-2.md F).
// Owned by M2-08; merged by ../record-tables.ts.
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['import_run'],
  idTables: { 'imports.get': 'import_run', 'imports.commit': 'import_run' },
  reads: { 'imports.templates': null, 'imports.get': 'import_run' },
};
