// The tables behind the record ids of the routes with `{ms}` and `{id}` (build plan D.1, F.7), shared by the
// cross-system, cross-organisation and owner-scope tests of WP-30. Milestone 2 (F): each building package keeps the
// entries of its routes in `record-tables/M2-nn.ts` (or `M2-Snn.ts`), merged here, so no two packages share a file.
import { RECORD_TABLES as M2_05 } from './record-tables/M2-05';
import { RECORD_TABLES as M2_06 } from './record-tables/M2-06';
import { RECORD_TABLES as M2_07 } from './record-tables/M2-07';
import { RECORD_TABLES as M2_08 } from './record-tables/M2-08';
import { RECORD_TABLES as M2_S09 } from './record-tables/M2-S09';
import { RECORD_TABLES as M2_S10 } from './record-tables/M2-S10';
import { RECORD_TABLES as M2_S11 } from './record-tables/M2-S11';

/** The record tables of one Milestone 2 building package. */
export interface RecordTables {
  /** New tables whose rows carry `management_system_id` (added to `DIRECT`). */
  direct: readonly string[];
  /** The table of the `{id}` of each new route with `{ms}` and `{id}` (added to `ID_TABLES`). */
  idTables: Readonly<Record<string, string>>;
  /**
   * Every new GET route of the package with the table of its record id (`{id}`), or null when the route names no
   * record. The owner-scope sweep reads a real id of that table once the stub is replaced.
   */
  reads: Readonly<Record<string, string | null>>;
}

/** The record tables of the Milestone 2 building packages, by package. */
export const M2_RECORD_TABLES: Readonly<Record<string, RecordTables>> = {
  'M2-05': M2_05, 'M2-06': M2_06, 'M2-07': M2_07, 'M2-08': M2_08, 'M2-S09': M2_S09, 'M2-S10': M2_S10, 'M2-S11': M2_S11,
};
const M2 = Object.values(M2_RECORD_TABLES);

/** Tables whose rows carry `management_system_id`; the others are shared through `entity_ms_link`. */
export const DIRECT = new Set([
  'applicability_entry', 'implementation_activity_progress', 'audit_event', 'audit_prep_task', 'cycle_requirement_status', 'risk_treatment',
  'finding', 'corrective_action', 'self_assessment', 'audit_activity', 'evidence_pack', 'auditor_access_grant', 'entity_ms_link',
  ...M2.flatMap((t) => t.direct),
]);

/** The table of the `{id}` of each new GET route of Milestone 2 (null: the route names no record). */
export const M2_READ_TABLES: Readonly<Record<string, string | null>> = Object.assign({}, ...M2.map((t) => t.reads));

/** The table of the `{id}` of each route with `{ms}` and a record id (the `{entityType}` routes are listed per type). */
export const ID_TABLES: Readonly<Record<string, string>> = {
  'readmodel.surveillance.event': 'audit_event',
  'applicability.transition': 'applicability_entry',
  'applicability.update': 'applicability_entry',
  'applicability.operating-criteria': 'applicability_entry',
  'activity.transition': 'implementation_activity_progress',
  'documents.transition': 'document',
  'documents.update': 'document',
  'documents.versions': 'document',
  'audit-events.update': 'audit_event',
  'prep-tasks.create': 'audit_event',
  'prep-tasks.update': 'audit_prep_task',
  'cycle-items.update': 'cycle_requirement_status',
  'registers.update': 'risk',
  'metrics.values.create': 'metric',
  'treatments.create': 'risk',
  'treatments.update': 'risk_treatment',
  'treatments.transition': 'risk_treatment',
  'risks.residual-acceptance': 'risk',
  'evidence.update': 'evidence',
  'evidence.targets.create': 'evidence',
  'evidence.targets.remove': 'evidence',
  'evidence.files': 'evidence',
  'entity-links.make-primary': 'entity_ms_link',
  'entity-links.remove': 'entity_ms_link',
  'findings.update': 'finding',
  'findings.transition': 'finding',
  'corrective-actions.update': 'corrective_action',
  'corrective-actions.transition': 'corrective_action',
  'self-assessments.raise-finding': 'self_assessment',
  'audit-activities.list': 'audit_event',
  'audit-activities.generate': 'audit_event',
  'audit-activities.update': 'audit_activity',
  'management-reviews.input': 'management_review',
  'management-reviews.transition': 'management_review',
  'evidence-packs.get': 'evidence_pack',
  'evidence-packs.download': 'evidence_pack',
  'auditor-access.revoke': 'auditor_access_grant',
  ...Object.assign({}, ...M2.map((t) => t.idTables)),
};
