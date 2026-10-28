// The model of the controls and requirements forms (MILESTONE-2 M2-11): the values of an applicability entry as the
// forms edit them, the request bodies of D.2 they turn into (types only, R-17), the checks before Save, and the
// interface both adapters implement (api.ts in API builds, sample.ts in the sample build, chosen in adapter.ts).
import type { ApplicabilityCreateRequest, ApplicabilityPatch, ApplicabilityTransitionRequest, OperatingCriteriaRequest } from '@mscd/shared';
import type { MsId } from '../../data/types';
import type { TextPair } from '../types';
import type { EntryRecord, Outcome, Result } from './common';
import { filled, targetOfEntry } from './common';
import { TEXT } from './text';

export type { ApplicabilityCreateRequest, ApplicabilityPatch, ApplicabilityTransitionRequest, OperatingCriteriaRequest };

/** A catalogue item or requirement of the active edition (`applicability.targets`, D.1). */
export interface TargetItem {
  kind: 'catalogue_item' | 'requirement';
  code: string;
  title: string;
  clauseGroup: string | null;
  hasEntry: boolean;
  retired: boolean;
  /** False for clause rows, which always apply (D2-09). */
  assessable: boolean;
  /** The pack asks for documented information on this row. */
  documentedInfo: boolean;
}

/** A risk of the system's register, for the linked risks of an entry. */
export interface RiskChoice {
  code: string;
  title: string;
}

/** A document of the system, with the controls and requirements it implements (snapshot ids). */
export interface DocChoice {
  code: string;
  title: string;
  implements: string[];
}

/** The entry a write is for: its system, record key and snapshot id, and its uuid and ETag from the snapshot refs. */
export interface EntryRef {
  ms: MsId;
  key: string;
  id: string;
  uuid: string | null;
  etag: string | null;
}

/** Everything the two adapters do. Every call answers a Result and never rejects (adapter.ts wraps them). */
export interface ControlsAdapter {
  targets(ms: MsId): Promise<Result<TargetItem[]>>;
  create(ms: MsId, body: ApplicabilityCreateRequest, idempotencyKey: string): Promise<Result<Outcome>>;
  update(entry: EntryRef, patch: ApplicabilityPatch): Promise<Result<Outcome>>;
  criteria(entry: EntryRef, body: OperatingCriteriaRequest): Promise<Result<Outcome>>;
  transition(entry: EntryRef, body: ApplicabilityTransitionRequest): Promise<Result<Outcome>>;
  remove(entry: EntryRef, reason: string, confirm: boolean): Promise<Result<Outcome>>;
  risks(ms: MsId): Promise<Result<RiskChoice[]>>;
  documents(ms: MsId): Promise<Result<DocChoice[]>>;
}

export const ADAPTER_METHODS: readonly (keyof ControlsAdapter)[] = ['targets', 'create', 'update', 'criteria', 'transition', 'remove', 'risks', 'documents'];

/** The values of the Edit form of an entry. */
export interface EntryValues {
  isApplicable: boolean;
  inclusion: string;
  exclusion: string;
  risks: string[];
  documents: string[];
  owner: string;
  holdsGate: boolean;
  gateReason: string;
  note: string;
  frequency: string;
  description: string;
}

/** The Edit form's starting values: the snapshot puts the justification that applies in `just` (G.5). */
export function valuesOf(entry: EntryRecord, documents: readonly string[]): EntryValues {
  const applies = entry.st !== 'na';
  return {
    isApplicable: applies,
    inclusion: applies ? entry.just ?? '' : '',
    exclusion: applies ? '' : entry.just ?? '',
    risks: [...(entry.risks ?? [])],
    documents: [...documents],
    owner: entry.owner && entry.owner !== 'none' ? entry.owner : 'none',
    holdsGate: Boolean(entry.gate),
    // The snapshot carries the status note and the gate flag without the gate reason: an empty reason keeps the stored one.
    gateReason: '',
    note: entry.note ?? '',
    frequency: entry.freq,
    description: '',
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const textOrNull = (text: string) => (filled(text) ? text.trim() : null);
const changedText = (a: string, b: string) => a.trim() !== b.trim();

/**
 * The PATCH body of the fields that changed, or null when none did. The documents are left out unless the form knew
 * every implementing document of the entry (`documentsKnown`): the PATCH replaces the list, and the snapshot names
 * only the first one.
 */
export function patchOf(initial: EntryValues, next: EntryValues, options: { documentsKnown: boolean }): ApplicabilityPatch | null {
  const patch: Record<string, unknown> = {};
  if (next.isApplicable !== initial.isApplicable) patch.isApplicable = next.isApplicable;
  if (changedText(next.inclusion, initial.inclusion)) patch.inclusionJustification = textOrNull(next.inclusion);
  if (changedText(next.exclusion, initial.exclusion) || (!next.isApplicable && initial.isApplicable)) {
    patch.exclusionJustification = textOrNull(next.exclusion);
  }
  if (next.owner !== initial.owner) patch.ownerHandle = next.owner || 'none';
  if (next.holdsGate !== initial.holdsGate) patch.holdsGate = next.holdsGate;
  if (next.holdsGate && changedText(next.gateReason, initial.gateReason)) patch.gateReason = textOrNull(next.gateReason);
  if (changedText(next.note, initial.note)) patch.statusNote = textOrNull(next.note);
  if (!sameList(next.risks, initial.risks)) patch.riskCodes = [...next.risks];
  if (options.documentsKnown && !sameList(next.documents, initial.documents)) patch.documentCodes = [...next.documents];
  return Object.keys(patch).length ? (patch as ApplicabilityPatch) : null;
}

/** The operating criteria body when the frequency or the description changed, else null. */
export function criteriaOf(initial: EntryValues, next: EntryValues): OperatingCriteriaRequest | null {
  const description = next.description.trim();
  if (next.frequency === initial.frequency && !description) return null;
  return description ? { frequencyCode: next.frequency, description } : { frequencyCode: next.frequency };
}

/** Field problems of the Edit form before Save, keyed by field; a gate set now needs its reason. */
export function checkValues(values: EntryValues, assessable: boolean, initial?: EntryValues): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (!values.isApplicable && !assessable) out.isApplicable = TEXT.alwaysApplicableReason;
  if (!values.isApplicable && !filled(values.exclusion)) out.exclusion = TEXT.exclusionRequired;
  if (values.holdsGate && !initial?.holdsGate && !filled(values.gateReason)) out.gateReason = TEXT.gateReasonRequired;
  if (values.description.length > 2000) out.description = TEXT.descriptionTooLong;
  for (const [field, text] of [['inclusion', values.inclusion], ['exclusion', values.exclusion]] as const) {
    if (text.trim().length > 4000) out[field] = TEXT.justificationTooLong;
  }
  for (const [field, text] of [['gateReason', values.gateReason], ['note', values.note]] as const) {
    if (text.trim().length > 1000) out[field] = TEXT.noteTooLong;
  }
  return out;
}

/** The values of the Add form. */
export interface CreateValues {
  target: TargetItem | null;
  isApplicable: boolean;
  inclusion: string;
  exclusion: string;
  owner: string;
  frequency: string;
}

export function checkCreate(values: CreateValues): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (!values.target) out.target = TEXT.targetRequired;
  if (values.target && !values.isApplicable && !values.target.assessable) out.isApplicable = TEXT.alwaysApplicableReason;
  if (!values.isApplicable && !filled(values.exclusion)) out.exclusion = TEXT.exclusionRequired;
  if (!values.frequency) out.frequency = TEXT.frequencyRequired;
  return out;
}

export function createBodyOf(values: CreateValues): ApplicabilityCreateRequest {
  const target = values.target!;
  const body: Record<string, unknown> = {
    targetType: target.kind,
    code: target.code,
    isApplicable: values.isApplicable,
    ownerHandle: values.owner || 'none',
    frequencyCode: values.frequency,
  };
  if (values.isApplicable && filled(values.inclusion)) body.inclusionJustification = values.inclusion.trim();
  if (!values.isApplicable) body.exclusionJustification = values.exclusion.trim();
  return body as ApplicabilityCreateRequest;
}

/** Targets the Add form offers: no entry yet and still in the standard (E.1), matching every word of the search. */
export function addable(targets: readonly TargetItem[], query: string): TargetItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return targets
    .filter((t) => !t.hasEntry && !t.retired)
    .filter((t) => words.every((w) => `${t.code} ${t.title}`.toLowerCase().includes(w)));
}

/** The target row of an entry, when the targets list holds it. */
export function targetOf(targets: readonly TargetItem[] | null | undefined, entry: Pick<EntryRecord, 'id'>): TargetItem | null {
  if (!targets) return null;
  const { targetType, code } = targetOfEntry(entry);
  return targets.find((t) => t.kind === targetType && t.code === code) ?? null;
}

/** Whether an entry can be marked not applicable: catalogue items can, clause rows cannot (APPL-ASSESS, D2-09). */
export function assessableOf(target: TargetItem | null, entry: Pick<EntryRecord, 'id'>): boolean {
  if (target) return target.assessable;
  return targetOfEntry(entry).targetType === 'catalogue_item';
}

/** The documents that implement an entry, from the register rows (`requirements` of `readmodel.documents.list`). */
export function implementingDocuments(docs: readonly DocChoice[], entry: Pick<EntryRecord, 'id'>): string[] {
  return docs.filter((d) => d.implements.includes(entry.id)).map((d) => d.code);
}

/** The reason the Delete form needs: 10 to 500 characters (`SoftDeleteRequest`, BR-19). */
export function checkReason(reason: string, min: number, max: number): TextPair | null {
  const n = reason.trim().length;
  if (n < min) return min > 1 ? TEXT.reasonTooShort : TEXT.reasonRequired;
  if (n > max) return TEXT.reasonTooLong;
  return null;
}
