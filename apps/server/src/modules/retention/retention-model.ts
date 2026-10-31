// Shared facts of retention and disposal review (Milestone 3 D.8, M3-06): the default retention period, the record
// classes in screen order with their names in both languages, date arithmetic in whole months, and the texts of the
// refusals the routes give besides the platform rules (RET-HOLD, RET-NOT-DUE, RET-CURRENT, SOD-SELF-APPROVE).
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
  evidence_pack: ['Evidence packs', 'Paket bukti'],
  audit_event: ['Audit events with a result', 'Peristiwa audit dengan hasil'],
  finding: ['Closed findings', 'Temuan yang ditutup'],
  corrective_action: ['Closed corrective actions', 'Tindakan korektif yang ditutup'],
  management_review: ['Closed management reviews', 'Tinjauan manajemen yang ditutup'],
  competence_record: ['Lapsed competence records', 'Catatan kompetensi yang kedaluwarsa'],
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
