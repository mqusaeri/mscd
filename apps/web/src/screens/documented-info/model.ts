// The model of Required documented information (MILESTONE-2 M2-12): the rows of `documented-info.list` (D.1), the
// adapter interface both builds implement (api.ts in API builds, sample.ts in the sample build, chosen in adapter.ts),
// and the pure rules of the screen: clause groups, the scope statement row (H.9), the actions a row offers and the
// count of missing items for the sidebar badge.
import type { MsId } from '../../data/types';
import type { Outcome, Result } from '../docs-edit/model';
import type { Tone } from '../ui';

export type DiState = 'missing' | 'draft' | 'in_review' | 'approved' | 'review_overdue' | 'fresh' | 'out_of_date';

/** One row of required documented information with what covers it (`DocumentedInfoItem`). */
export interface DiRow {
  code: string;
  requirementCode: string;
  kind: 'maintain' | 'retain';
  title: string;
  templateCode: string | null;
  state: DiState;
  document: {
    id: string;
    code: string;
    title: string;
    /** UI status of the document (approved, expired, review, draft). */
    status: string;
    nextReviewAt: string | null;
    owner: string;
    /** True when the document stands for the pack code through `documented-info.link`. */
    linked: boolean;
  } | null;
  evidence: { code: string; title: string; fresh: string }[];
  /**
   * Records to retain with a template code: the document that stands for the template code (its own code or a link,
   * BR-40), which the activities that expect the code use; null when none does. The api keeps a record's `document`
   * empty, so the adapters find it (see `documentForCode`).
   */
  templateDocument?: CodeDocument | null;
  /**
   * Records to retain with a template code: true when an activity of the snapshot expects the template code or a row to
   * maintain names it as its pack code. Only then can the screen read a link of the code back after a new page load
   * (the activity or the row shows the linked document), so only then does the row offer the link actions.
   */
  templateLinkable?: boolean;
  /** The Indonesian title when the source has one (the sample packs); the screen shows `title` otherwise. */
  titleId?: string | null;
}

/** The document that stands for a pack code: its code and title, and whether a link made it stand for the code. */
export interface CodeDocument {
  code: string;
  title: string;
  linked: boolean;
}

export interface DiAdapter {
  /** `GET /ms/{ms}/documented-information`. */
  list(ms: MsId): Promise<Result<DiRow[]>>;
  /** `PUT /ms/{ms}/documented-information/{code}/link`: the document (its uuid or sample code) or null to remove. */
  link(ms: MsId, packCode: string, documentId: string | null): Promise<Result<Outcome>>;
  /** The id `link` takes for a document of the snapshot: its uuid (api) or its code (sample); null when not loaded. */
  documentId(ms: MsId, code: string): string | null;
}

/** Clause groups 4 to 10 of the harmonised structure, with their titles. */
export const CLAUSE_GROUPS: readonly { group: string; title: readonly [string, string] }[] = [
  { group: '4', title: ['Clause 4, Context of the organisation', 'Klausul 4, Konteks organisasi'] },
  { group: '5', title: ['Clause 5, Leadership', 'Klausul 5, Kepemimpinan'] },
  { group: '6', title: ['Clause 6, Planning', 'Klausul 6, Perencanaan'] },
  { group: '7', title: ['Clause 7, Support', 'Klausul 7, Dukungan'] },
  { group: '8', title: ['Clause 8, Operation', 'Klausul 8, Operasi'] },
  { group: '9', title: ['Clause 9, Performance evaluation', 'Klausul 9, Evaluasi kinerja'] },
  { group: '10', title: ['Clause 10, Improvement', 'Klausul 10, Peningkatan'] },
];

/** The clause group of a requirement code (`9.2.2` gives `9`). */
export function clauseGroup(requirementCode: string): string {
  return String(requirementCode).split('.')[0] ?? '';
}

/** Rows grouped by clause 4 to 10, in list order; a group without rows is left out, other groups come last. */
export function groupRows(rows: readonly DiRow[]): { group: string; rows: DiRow[] }[] {
  const known = CLAUSE_GROUPS.map((g) => g.group);
  const out = known.map((group) => ({ group, rows: rows.filter((r) => clauseGroup(r.requirementCode) === group) }));
  const other = rows.filter((r) => !known.includes(clauseGroup(r.requirementCode)));
  if (other.length) out.push({ group: '', rows: other });
  return out.filter((g) => g.rows.length > 0);
}

/**
 * The row of the scope statement (H.9): the row whose template is a scope statement template (`SCO-01`, `SCO-Q01`),
 * else the `maintain` row of clause 4.3 or one of its sub-clauses; null when the pack has none.
 */
export function scopeRow(rows: readonly DiRow[]): DiRow | null {
  return rows.find((r) => /^SCO-/i.test(r.templateCode ?? ''))
    ?? rows.find((r) => r.kind === 'maintain' && (r.requirementCode === '4.3' || r.requirementCode.startsWith('4.3.')))
    ?? null;
}

/** The pack code a row maps a document to with `documented-info.link`: its template code, else its own code. */
export const packCodeOf = (row: Pick<DiRow, 'templateCode' | 'code'>): string => row.templateCode ?? row.code;

/** The number of rows with nothing in place (the sidebar badge). */
export function missingCount(rows: readonly Pick<DiRow, 'state'>[]): number {
  return rows.filter((r) => r.state === 'missing').length;
}

/**
 * The document that stands for the pack code of a row: the document with the template code or the row's own code, or
 * the document linked to it with `documented-info.link`. These are the documents activities resolve (BR-40). Null when
 * nothing covers the row, or when only an implementing document of the clause covers it (the list shows that document
 * and its state, but an activity that expects the pack code does not use it).
 */
export function standingDocument(row: Pick<DiRow, 'document' | 'templateCode' | 'code'>): DiRow['document'] {
  const doc = row.document;
  if (!doc) return null;
  return doc.linked || doc.code === row.templateCode || doc.code === row.code ? doc : null;
}

/**
 * The document that stands for the pack code of a row, for both kinds: the standing document of a `maintain` row, the
 * template document of a `retain` row with a template code; null otherwise.
 */
export function codeDocumentOf(row: DiRow): CodeDocument | null {
  if (row.kind === 'retain') return row.templateCode ? row.templateDocument ?? null : null;
  const doc = standingDocument(row);
  return doc ? { code: doc.code, title: doc.title, linked: doc.linked } : null;
}

/**
 * What a row offers to someone who manages documents, for its pack code (the template code, else the row's own code
 * for a `maintain` row): "Register from template" (with a template) and "Link existing document" while no document
 * stands for the code (also when only an implementing document of the clause covers a `maintain` row, which
 * activities do not use), "Change link" and "Remove link" for a linked document. A record to retain keeps its evidence
 * and offers these for its template code only, since activities may expect that code (BR-40, for example PRC-04 of
 * ISO/IEC 27001); a record without a template offers none. The link actions of a record need `templateLinkable`: a
 * link of a code that no activity expects and no row to maintain names could not be read back after a new page load.
 */
export function rowActions(row: DiRow): { register: boolean; link: boolean; relink: boolean; unlink: boolean } {
  if (row.kind === 'retain' && !row.templateCode) return { register: false, link: false, relink: false, unlink: false };
  const standing = codeDocumentOf(row);
  const linkable = row.kind === 'maintain' || Boolean(row.templateLinkable);
  const linked = linkable && Boolean(standing?.linked);
  return {
    register: !standing && Boolean(row.templateCode),
    link: !standing && linkable,
    relink: linked,
    unlink: linked,
  };
}

/** True when an activity expects the pack code or a row to maintain names it, so a link of the code can be read back. */
export function linkableCode(code: string, rows: readonly Pick<DiRow, 'kind' | 'templateCode' | 'code'>[], acts: readonly { out: string | null }[]): boolean {
  return acts.some((a) => a.out === code) || rows.some((r) => r.kind === 'maintain' && packCodeOf(r) === code);
}

/** What the snapshot shows about the documents that stand for pack codes (the api build). */
export interface CodeSources {
  /** The documents of the system: code and title. */
  docs: readonly { code: string; title: string }[];
  /** The activities of the system: the pack code each expects and the code of the document it resolves to (BR-40). */
  acts: readonly { out: string | null; doc: string | null }[];
}

/**
 * The document that stands for a pack code, as far as the list and the snapshot show it: the document with that code,
 * else the standing document of a `maintain` row with that pack code, else the document an activity that expects the
 * code resolves to (a link). Null when none does, also for a link of a code that no activity expects and no row to
 * maintain names (such a record offers no link actions, see `rowActions`).
 */
export function documentForCode(code: string, rows: readonly DiRow[], src: CodeSources): CodeDocument | null {
  const titleOf = (c: string) => src.docs.find((d) => d.code === c)?.title ?? '';
  if (src.docs.some((d) => d.code === code)) return { code, title: titleOf(code), linked: false };
  for (const r of rows) {
    if (r.kind !== 'maintain' || packCodeOf(r) !== code) continue;
    const doc = standingDocument(r);
    if (doc) return { code: doc.code, title: doc.title, linked: doc.linked };
  }
  const doc = src.acts.find((a) => a.out === code && a.doc && a.doc !== code)?.doc;
  return doc ? { code: doc, title: titleOf(doc), linked: true } : null;
}

/** The rows with the template document of each record to retain that has a template code, and whether it is linkable. */
export function withTemplateDocuments(rows: readonly DiRow[], src: CodeSources): DiRow[] {
  return rows.map((r) => (r.kind === 'retain' && r.templateCode
    ? { ...r, templateDocument: documentForCode(r.templateCode, rows, src), templateLinkable: linkableCode(r.templateCode, rows, src.acts) }
    : r));
}

/** Integrity states of a pinned evidence file that cannot be verified (product decision 8, the Evidence freshness tab). */
const UNVERIFIABLE: ReadonlySet<string> = new Set(['changed', 'moved', 'missing', 'revoked']);

/** True when the pinned file of an evidence item cannot be verified; the item status stays as it is (decision 8). */
export const cannotVerify = (integ: string | null | undefined): boolean => Boolean(integ && UNVERIFIABLE.has(integ));

/** Badge tone of a state. */
export const STATE_TONES: Readonly<Record<DiState, Tone>> = {
  missing: 'bad',
  draft: 'info',
  in_review: 'warn',
  approved: 'ok',
  review_overdue: 'bad',
  fresh: 'ok',
  out_of_date: 'warn',
};

/** True when a state counts as approved for the scope statement (an approved version is in force). */
export const inForce = (state: DiState): boolean => state === 'approved' || state === 'review_overdue';
