// Shared facts of retention and disposal review (Milestone 3 D.8, M3-06): the default retention period, the record
// classes in screen order with their names in both languages, date arithmetic in whole months, and the texts of the
// refusals the routes give besides the platform rules (RET-HOLD, RET-NOT-DUE, RET-CURRENT, SOD-SELF-APPROVE).
// M3-13 (product owner decision 18): what a disposal clears in a record and its child rows (`DISPOSAL_CLEARS`), and the
// text and person columns it keeps, each with the reason (`DISPOSAL_KEEPS`); a column test holds both lists complete.
import type { Pair, RetentionRecordClass } from '@mscd/shared';
import { RETENTION_RECORD_CLASSES } from '@mscd/shared';

/** H.8: every record class is kept 36 months (one certification cycle) unless the system sets another period. */
export const DEFAULT_RETAIN_MONTHS = 36;

/** The record classes in the order of D.8 (and of the Rules tab). */
export const RECORD_CLASSES: readonly RetentionRecordClass[] = RETENTION_RECORD_CLASSES;

/** Names of the record classes in English and Indonesian, for notices and the register. */
export const CLASS_NAMES: Readonly<Record<RetentionRecordClass, Pair>> = {
  document_version: ['Earlier document versions', 'Versi dokumen sebelumnya'],
  evidence_file: ['Earlier evidence files', 'Berkas bukti sebelumnya'],
  evidence_pack: ['Evidence packs', 'Evidence pack'],
  audit_event: ['Audit events with a result', 'Event audit dengan hasil'],
  finding: ['Closed findings', 'Temuan yang ditutup'],
  corrective_action: ['Closed corrective actions', 'Tindakan korektif yang ditutup'],
  management_review: ['Closed management reviews', 'Tinjauan manajemen yang ditutup'],
  competence_record: ['Lapsed competence records', 'Rekaman kompetensi yang kedaluwarsa'],
};

/** Classes whose items are database records: a disposal marks the record deleted (`deleted_at`), as BP C.1 keeps rows. */
export const RECORD_TABLE_CLASSES: Readonly<Partial<Record<RetentionRecordClass, string>>> = {
  audit_event: 'audit_event',
  finding: 'finding',
  corrective_action: 'corrective_action',
  management_review: 'management_review',
  competence_record: 'competence_record',
};

/** The entity type of the `record.disposed` audit entry of an item of a class. */
export const DISPOSED_ENTITY_TYPE: Readonly<Record<RetentionRecordClass, string>> = {
  document_version: 'document_version',
  evidence_file: 'storage_object',
  evidence_pack: 'evidence_pack',
  audit_event: 'audit_event',
  finding: 'finding',
  corrective_action: 'corrective_action',
  management_review: 'management_review',
  competence_record: 'competence_record',
};

/**
 * `iso` plus `months` whole months, the day kept or moved back to the last day of a shorter month (2024-01-31 plus one
 * month is 2024-02-29), as PostgreSQL's `date + interval 'n months'` does.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The later of two ISO dates (null counts as earliest). */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Key of a rule: the class and, for document versions, the document type. */
export function ruleKey(recordClass: RetentionRecordClass, docType: string | null | undefined): string {
  return recordClass === 'document_version' ? `${recordClass}:${docType ?? ''}` : recordClass;
}

/** The months in force for an item: the system's rule of its class (and document type), else the default. */
export function monthsFor(rules: ReadonlyMap<string, number>, recordClass: RetentionRecordClass, docType: string | null | undefined): number {
  return rules.get(ruleKey(recordClass, docType)) ?? DEFAULT_RETAIN_MONTHS;
}

/** The tables a disposal clears: the five record classes that are rows, and the child rows of two of them. */
export type DisposalTable =
  | 'audit_event' | 'audit_prep_task' | 'audit_activity' | 'finding' | 'corrective_action' | 'management_review' | 'management_review_input'
  | 'competence_record';

/** The child rows of a record that a disposal clears with it, by the column that links them to the record. */
export const DISPOSAL_CHILDREN: Readonly<Partial<Record<DisposalTable, readonly { table: DisposalTable; parentColumn: string }[]>>> = {
  audit_event: [
    { table: 'audit_activity', parentColumn: 'audit_event_id' },
    { table: 'audit_prep_task', parentColumn: 'audit_event_id' },
  ],
  management_review: [{ table: 'management_review_input', parentColumn: 'management_review_id' }],
};

/** The text that replaces a required text column of a disposed record (English, or Indonesian for `name_id`). */
export const DISPOSED_TEXT = 'Disposed of';
export const DISPOSED_TEXT_ID = 'Dimusnahkan';

/**
 * What a disposal clears (decision 18, D.8): the free-text and person columns become null (`nulls`), the required text
 * columns take a fixed text (`texts`). Codes, classifications, statuses, dates and links to other records stay.
 */
export const DISPOSAL_CLEARS: Readonly<Record<DisposalTable, { nulls: readonly string[]; texts: Readonly<Record<string, string>> }>> = {
  audit_event: {
    nulls: ['lead_auditor_name', 'expected_focus', 'outcome_summary', 'scope_text'],
    texts: { name_en: DISPOSED_TEXT, name_id: DISPOSED_TEXT_ID },
  },
  audit_prep_task: { nulls: ['note', 'owner_user_id'], texts: { title: DISPOSED_TEXT } },
  audit_activity: {
    nulls: ['key_questions', 'evidence_to_request', 'note', 'auditee_user_id', 'auditor_user_id'],
    texts: { title: DISPOSED_TEXT },
  },
  finding: {
    nulls: ['status_note', 'rca_text', 'systemic_check_text', 'close_note', 'owner_user_id', 'closed_by_user_id'],
    texts: { title: DISPOSED_TEXT },
  },
  corrective_action: {
    nulls: [
      'correction_text', 'rca_text', 'systemic_check_text', 'action_text', 'verification_note', 'owner_user_id', 'implemented_by_user_id',
      'verified_by_user_id',
    ],
    texts: { title: DISPOSED_TEXT },
  },
  management_review: { nulls: ['decisions_text', 'owner_user_id', 'closed_by_user_id'], texts: { title: DISPOSED_TEXT } },
  management_review_input: { nulls: ['content'], texts: {} },
  competence_record: {
    nulls: ['user_id', 'pending_action', 'verified_by', 'owner_user_id'],
    texts: { role_title: DISPOSED_TEXT, competence_required: DISPOSED_TEXT },
  },
};

const WHO_CHANGED = 'who created and last changed the row, as every audit entry keeps who acted';

/** The text and person columns a disposal keeps, with the reason (the column test reads both lists). */
export const DISPOSAL_KEEPS: Readonly<Record<DisposalTable, Readonly<Record<string, string>>>> = {
  audit_event: {
    created_by: WHO_CHANGED, updated_by: WHO_CHANGED,
    event_type: 'classification of the event',
    short_label: 'the code of the event in the disposal register and the audit entries',
    outcome: 'classification of the result',
  },
  audit_prep_task: { created_by: WHO_CHANGED, updated_by: WHO_CHANGED, template_code: 'code of the pack template', status: 'status' },
  audit_activity: {
    created_by: WHO_CHANGED, updated_by: WHO_CHANGED,
    template_code: 'code of the pack template', clause_ref: 'code of the clause or control', status: 'status', target_code: 'code of the clause or control',
  },
  finding: {
    created_by: WHO_CHANGED, updated_by: WHO_CHANGED,
    code: 'the code of the record', classification: 'classification', clause_ref: 'code of the clause or control', source: 'classification of the source',
    status: 'status', target_code: 'code of the clause or control',
  },
  corrective_action: { created_by: WHO_CHANGED, updated_by: WHO_CHANGED, code: 'the code of the record', status: 'status' },
  management_review: { created_by: WHO_CHANGED, updated_by: WHO_CHANGED, code: 'the code of the record', status: 'status' },
  management_review_input: { created_by: WHO_CHANGED, updated_by: WHO_CHANGED, source_refs: 'links to other records by their code' },
  competence_record: { created_by: WHO_CHANGED, updated_by: WHO_CHANGED, proof_type: 'classification of the proof' },
};
