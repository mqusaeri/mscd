// Record tables of the routes of M2-06: organisation settings, onboarding, account security and the operator organisation list (docs/platform/MILESTONE-2.md F).
// Owned by M2-06; merged by ../record-tables.ts. None of the routes names a record id or a system in its path: the
// organisation settings and the onboarding checklist read the session's organisation, the security overview the
// session user, and the operator list every organisation (platform scope).
import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: [],
  idTables: {},
  reads: { 'admin.organization.get': null, 'admin.onboarding': null, 'me.security': null, 'ops.organizations.list': null },
};
