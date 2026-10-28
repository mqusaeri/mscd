// The model of the evidence forms (MILESTONE-2 M2-11): the values of New and Edit evidence and the request bodies of
// D.2 they turn into (types only, R-17), the targets of an evidence record, the freshness limits per frequency, the
// checks before Save, and the interface both adapters implement (api.ts in API builds, sample.ts in the sample build).
import type {
  Classification, EvidenceCreate, EvidencePatch, EvidenceTargetRequest, FreshnessThresholdItem, FreshnessThresholdSet,
} from '@mscd/shared';
import type { Evidence, MsId } from '../../data/types';
import type { PickedFile, TextPair } from '../types';
import { filled } from '../controls-edit/common';
import type { Outcome, Result } from '../controls-edit/common';
import { TEXT } from './text';

export type { Classification, EvidenceCreate, EvidencePatch, EvidenceTargetRequest, FreshnessThresholdItem, FreshnessThresholdSet };

/** A control or requirement an evidence record serves, in a system; `id` is the target's uuid when it is known. */
export interface EvidenceTarget {
  id: string | null;
  ms: MsId;
  targetType: 'catalogue_item' | 'requirement';
  code: string;
}

/** The targets of an evidence record; `complete` is false when only the first target of each system is known. */
export interface TargetList {
  targets: EvidenceTarget[];
  complete: boolean;
}

/** The evidence a write is for: its system and code, and its uuid and ETag from the snapshot refs. */
export interface EvidenceRef {
  ms: MsId;
  code: string;
  uuid: string | null;
  etag: string | null;
}

export type Threshold = FreshnessThresholdItem;

export interface EvidenceAdapter {
  create(ms: MsId, body: EvidenceCreate, idempotencyKey: string): Promise<Result<Outcome>>;
  update(ev: EvidenceRef, patch: EvidencePatch): Promise<Result<Outcome>>;
  addTarget(ev: EvidenceRef, body: EvidenceTargetRequest, idempotencyKey: string): Promise<Result<Outcome>>;
  removeTarget(ev: EvidenceRef, target: EvidenceTarget, reason: string): Promise<Result<Outcome>>;
  targets(ev: EvidenceRef): Promise<Result<TargetList>>;
  attach(ev: EvidenceRef, file: PickedFile, producedAt: string): Promise<Result<Outcome>>;
  thresholds(ms: MsId): Promise<Result<Threshold[]>>;
  setThreshold(ms: MsId, frequencyCode: string, body: FreshnessThresholdSet): Promise<Result<Outcome>>;
}

export const ADAPTER_METHODS: readonly (keyof EvidenceAdapter)[] = ['create', 'update', 'addTarget', 'removeTarget', 'targets', 'attach', 'thresholds', 'setThreshold'];

/** A target picked in a form: the snapshot id of an entry (`A.5.7`, `Cl. 9.1`) in a system. */
export interface PickedTarget {
  ms: MsId;
  id: string;
}

/** The values of New and Edit evidence. */
export interface EvidenceValues {
  code: string;
  title: string;
  owner: string;
  frequency: string;
  /** Empty in Edit means "keep the current classification" (the snapshot does not carry it). */
  classification: string;
  /** Entries of the form's system (New only). */
  targets: string[];
  /** Entries of other systems, added after the record is created (New only). */
  others: PickedTarget[];
}

/** The target of an entry id: `Cl. 9.1` is the requirement 9.1, any other id the catalogue item of that code. */
export function targetOfId(id: string): { targetType: 'catalogue_item' | 'requirement'; code: string } {
  return /^Cl\.\s/.test(id) ? { targetType: 'requirement', code: id.replace(/^Cl\.\s+/, '') } : { targetType: 'catalogue_item', code: id };
}

/** The entry id of a target (inverse of `targetOfId`). */
export function idOfTarget(t: Pick<EvidenceTarget, 'targetType' | 'code'>): string {
  return t.targetType === 'catalogue_item' ? t.code : `Cl. ${t.code}`;
}

const CODE_PATTERN = /^\S(?:.*\S)?$/;

/** Field problems of New or Edit evidence, keyed by field. `taken` are the codes that already exist. */
export function checkEvidence(values: EvidenceValues, mode: 'new' | 'edit', taken: readonly string[] = []): Record<string, TextPair> {
  const out: Record<string, TextPair> = {};
  if (mode === 'new') {
    const code = values.code.trim();
    if (!code || code.length > 30 || !CODE_PATTERN.test(code)) out.code = TEXT.codeRequired;
    else if (taken.some((c) => c.toLowerCase() === code.toLowerCase())) out.code = [TEXT.codeTaken[0].replace('{code}', code), TEXT.codeTaken[1].replace('{code}', code)];
    if (!values.targets.length) out.targets = TEXT.noTargets;
    if (!values.classification) out.classification = TEXT.classificationRequired;
  }
  const title = values.title.trim();
  if (!title || title.length > 255) out.title = TEXT.titleRequired;
  if (!values.owner || values.owner === 'none') out.owner = TEXT.ownerRequired;
  if (!values.frequency) out.frequency = TEXT.frequencyRequired;
  return out;
}

export function createBodyOf(values: EvidenceValues): EvidenceCreate {
  return {
    code: values.code.trim(),
    title: values.title.trim(),
    ownerHandle: values.owner,
    frequencyCode: values.frequency,
    classification: values.classification as Classification,
    targets: values.targets.map((id) => targetOfId(id)).map((t) => ({ targetType: t.targetType, code: t.code })),
  };
}

/** The PATCH body of what changed in Edit, or null when nothing did. */
export function patchOf(initial: EvidenceValues, next: EvidenceValues, confirm = false): EvidencePatch | null {
  const patch: Record<string, unknown> = {};
  if (next.title.trim() !== initial.title.trim()) patch.title = next.title.trim();
  if (next.owner !== initial.owner) patch.ownerHandle = next.owner;
  if (next.frequency !== initial.frequency) patch.frequencyCode = next.frequency;
  if (next.classification && next.classification !== initial.classification) patch.classification = next.classification;
  if (!Object.keys(patch).length) return null;
  if (confirm) patch.confirm = true;
  return patch as EvidencePatch;
}

/** Edit's starting values from the snapshot evidence. */
export function valuesOfEvidence(e: Pick<Evidence, 'code' | 'title' | 'owner' | 'freq'>): EvidenceValues {
  return { code: e.code, title: e.title, owner: e.owner && e.owner !== 'none' ? e.owner : '', frequency: e.freq, classification: '', targets: [], others: [] };
}

/**
 * A code suggestion for new evidence of a system: the prefix the system's evidence uses (`EV-`, `EQ-`) and the next
 * free number with the same width, else `EV-0001`.
 */
export function suggestCode(codes: readonly string[]): string {
  let best: { prefix: string; width: number; max: number; count: number } | null = null;
  const groups = new Map<string, { width: number; max: number; count: number }>();
  for (const code of codes) {
    const m = /^(.*?)(\d+)$/.exec(code);
    if (!m) continue;
    const g = groups.get(m[1]) ?? { width: m[2].length, max: 0, count: 0 };
    g.max = Math.max(g.max, Number(m[2]));
    g.width = Math.max(g.width, m[2].length);
    g.count += 1;
    groups.set(m[1], g);
  }
  for (const [prefix, g] of groups) if (!best || g.count > best.count) best = { prefix, ...g };
  if (!best) return 'EV-0001';
  let n = best.max + 1;
  const taken = new Set(codes.map((c) => c.toLowerCase()));
  let code = `${best.prefix}${String(n).padStart(best.width, '0')}`;
  while (taken.has(code.toLowerCase())) {
    n += 1;
    code = `${best.prefix}${String(n).padStart(best.width, '0')}`;
  }
  return code;
}

/** The values of one row of the freshness limits, as typed. */
export interface ThresholdValues {
  graceDays: string;
  agingFactor: string;
  expiredFactor: string;
}

export function thresholdValuesOf(t: Threshold): ThresholdValues {
  return { graceDays: String(t.graceDays), agingFactor: String(t.agingFactor), expiredFactor: String(t.expiredFactor) };
}

/** The PUT body of a row, or its field problems. */
export function thresholdBodyOf(values: ThresholdValues): { ok: true; body: { graceDays: number; agingFactor: number; expiredFactor: number } } | { ok: false; fields: Record<string, TextPair> } {
  const fields: Record<string, TextPair> = {};
  const num = (s: string) => (filled(s) && /^\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const grace = num(values.graceDays);
  const aging = num(values.agingFactor);
  const expired = num(values.expiredFactor);
  if (!Number.isFinite(grace) || grace < 0 || grace > 365) fields.graceDays = TEXT.graceRange;
  if (!Number.isFinite(aging) || aging < 1 || aging > 100) fields.agingFactor = TEXT.factorRange;
  if (!Number.isFinite(expired) || expired < 1 || expired > 100) fields.expiredFactor = TEXT.factorRange;
  else if (Number.isFinite(aging) && expired < aging) fields.expiredFactor = TEXT.expiredBelowAging;
  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, body: { graceDays: grace, agingFactor: aging, expiredFactor: expired } };
}

/** The defaults of E.3 (`DEFAULT_THRESHOLDS` of the server): one grace day, aging at 1.25 times the period, expired at 2 times. */
export const DEFAULT_LIMITS = { graceDays: 1, agingFactor: 1.25, expiredFactor: 2 } as const;
