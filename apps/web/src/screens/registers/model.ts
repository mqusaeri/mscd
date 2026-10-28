// The model of the Registers screen (MILESTONE-2 M2-13): the register kinds and their fields (`RegisterItem` of
// packages/shared/src/api/risk-registers.ts), the form helpers (RegisterCreate and RegisterPatch bodies), who may do
// what (F.6), the C.13 moves of risk treatments, and the interface both adapters implement (api.ts in API builds,
// sample.ts in the sample build), chosen by the build in adapter.ts (MILESTONE-2 C.6). Types only from @mscd/shared
// (R-17).
import type {
  MetricValueRequest, RegisterCreate, RegisterItem, RegisterKind, RegisterPatch, ResidualAcceptanceRequest, TreatmentCreate, TreatmentStatus,
} from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, PickedFile, TextPair } from '../types';
import { KIND_TEXT, TEXT, VALUE_TEXT } from './text';

export type { RegisterKind, TreatmentStatus };

/** The answer of an adapter call: the data, or the api's error (field errors and rule kept). */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** What a write tells the screen: the server's message, warnings, the systems whose snapshot changed. */
export interface Outcome {
  message: TextPair | null;
  warnings: TextPair[];
  changed: MsId[];
  /** The record the write created or changed: its uuid (api) or sample id, its code, and its new ETag when the api names it. */
  ref?: { id: string; code: string; etag?: string } | null;
  /** `data` of the command result (for example `storageObjectId` of an evidence file). */
  data?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Register kinds and their fields
// ---------------------------------------------------------------------------------------------------------------

/** The tabs in display order. */
export const KINDS: readonly RegisterKind[] = ['context-issues', 'interested-parties', 'assets', 'risks', 'metrics', 'objectives', 'competence'];

/** A field of a register kind (a member of `RegisterItem`). */
export type FieldKey =
  | 'issueType' | 'description' | 'lastReviewedAt' | 'requirements' | 'assetType' | 'classification' | 'isOpportunity'
  | 'likelihood' | 'consequence' | 'residualLikelihood' | 'residualConsequence' | 'treatmentOption' | 'assessedAt' | 'nextReviewAt'
  | 'unit' | 'targetValue' | 'frequencyCode' | 'statement' | 'targetText' | 'metricCode' | 'dueAt' | 'resources' | 'evaluationMethod'
  | 'objectiveStatus' | 'result' | 'achievedAt' | 'personHandle' | 'competenceRequired' | 'proofType' | 'proofObjectId' | 'validUntil'
  | 'verifiedByHandle';

export type FieldType = 'text' | 'textarea' | 'date' | 'select' | 'score' | 'number' | 'person' | 'personOrNone' | 'metric' | 'bool' | 'proof';

export interface FieldDef {
  key: FieldKey;
  label: TextPair;
  type: FieldType;
  hint?: TextPair;
  required?: boolean;
  max?: number;
  /** Values of a `select` field with their labels. */
  options?: Readonly<Record<string, TextPair>>;
}

export const FIELDS: Readonly<Record<FieldKey, FieldDef>> = {
  issueType: { key: 'issueType', label: TEXT.fIssueType, type: 'select', options: VALUE_TEXT.issueType },
  description: { key: 'description', label: TEXT.fDescription, type: 'textarea', max: 4000 },
  lastReviewedAt: { key: 'lastReviewedAt', label: TEXT.fLastReviewed, type: 'date' },
  requirements: { key: 'requirements', label: TEXT.fRequirements, type: 'textarea', max: 4000 },
  assetType: { key: 'assetType', label: TEXT.fAssetType, type: 'text', max: 40, hint: TEXT.fAssetTypeHint },
  classification: { key: 'classification', label: TEXT.fClassification, type: 'select', options: VALUE_TEXT.classification },
  isOpportunity: { key: 'isOpportunity', label: TEXT.fOpportunity, type: 'bool' },
  likelihood: { key: 'likelihood', label: TEXT.fLikelihood, type: 'score', hint: TEXT.fScaleHint },
  consequence: { key: 'consequence', label: TEXT.fConsequence, type: 'score', hint: TEXT.fScaleHint },
  residualLikelihood: { key: 'residualLikelihood', label: TEXT.fResidualLikelihood, type: 'score', hint: TEXT.fResidualHint },
  residualConsequence: { key: 'residualConsequence', label: TEXT.fResidualConsequence, type: 'score', hint: TEXT.fResidualHint },
  treatmentOption: { key: 'treatmentOption', label: TEXT.fTreatmentOption, type: 'select', options: VALUE_TEXT.treatmentOption },
  assessedAt: { key: 'assessedAt', label: TEXT.fAssessedAt, type: 'date' },
  nextReviewAt: { key: 'nextReviewAt', label: TEXT.fNextReview, type: 'date' },
  unit: { key: 'unit', label: TEXT.fUnit, type: 'text', max: 20 },
  targetValue: { key: 'targetValue', label: TEXT.fTargetValue, type: 'number' },
  frequencyCode: { key: 'frequencyCode', label: TEXT.fFrequency, type: 'select' },
  statement: { key: 'statement', label: TEXT.fStatement, type: 'textarea', max: 4000 },
  targetText: { key: 'targetText', label: TEXT.fTargetText, type: 'text', max: 150, hint: TEXT.fTargetTextHint },
  metricCode: { key: 'metricCode', label: TEXT.fMetric, type: 'metric' },
  dueAt: { key: 'dueAt', label: TEXT.fDueAt, type: 'date' },
  resources: { key: 'resources', label: TEXT.fResources, type: 'textarea', max: 4000 },
  evaluationMethod: { key: 'evaluationMethod', label: TEXT.fEvaluation, type: 'textarea', max: 4000 },
  objectiveStatus: { key: 'objectiveStatus', label: TEXT.fObjectiveStatus, type: 'select', options: VALUE_TEXT.objectiveStatus },
  result: { key: 'result', label: TEXT.fResult, type: 'textarea', max: 4000 },
  achievedAt: { key: 'achievedAt', label: TEXT.fAchievedAt, type: 'date' },
  personHandle: { key: 'personHandle', label: TEXT.fPerson, type: 'person', required: true },
  competenceRequired: { key: 'competenceRequired', label: TEXT.fCompetence, type: 'textarea', required: true, max: 4000 },
  proofType: { key: 'proofType', label: TEXT.fProofType, type: 'select', required: true, options: VALUE_TEXT.proofType },
  proofObjectId: { key: 'proofObjectId', label: TEXT.fProofFile, type: 'proof' },
  validUntil: { key: 'validUntil', label: TEXT.fValidUntil, type: 'date' },
  verifiedByHandle: { key: 'verifiedByHandle', label: TEXT.fVerifiedBy, type: 'personOrNone' },
};

export interface KindDef {
  id: RegisterKind;
  /** Table of the kind (`REGISTER_ENTITY_TYPES`), the entity type of entity links. */
  entity: string;
  /** Prefix of a new code; null for competence, whose code the server derives from the id. */
  prefix: string | null;
  /** Linked to systems through `entity_ms_link` (objectives belong to one system). */
  shared: boolean;
  /** Links are made by code with `entity-links.create`; competence has no code and changes `linkedMs`. */
  linkByCode: boolean;
  /** The owner is never none (objectives, competence) or required by BR-17 (risks). */
  ownerRequired: boolean;
  fields: readonly FieldKey[];
}

export const KIND_DEFS: Readonly<Record<RegisterKind, KindDef>> = {
  'context-issues': { id: 'context-issues', entity: 'context_issue', prefix: 'CI-', shared: true, linkByCode: true, ownerRequired: false, fields: ['issueType', 'description', 'lastReviewedAt'] },
  'interested-parties': { id: 'interested-parties', entity: 'interested_party', prefix: 'IP-', shared: true, linkByCode: true, ownerRequired: false, fields: ['requirements', 'lastReviewedAt'] },
  'assets': { id: 'assets', entity: 'asset', prefix: 'AS-', shared: true, linkByCode: true, ownerRequired: false, fields: ['assetType', 'classification'] },
  'risks': {
    id: 'risks', entity: 'risk', prefix: 'R-', shared: true, linkByCode: true, ownerRequired: true,
    fields: ['isOpportunity', 'description', 'likelihood', 'consequence', 'residualLikelihood', 'residualConsequence', 'treatmentOption', 'assessedAt', 'nextReviewAt'],
  },
  'metrics': { id: 'metrics', entity: 'metric', prefix: 'M-', shared: true, linkByCode: true, ownerRequired: false, fields: ['unit', 'targetValue', 'frequencyCode'] },
  'objectives': {
    id: 'objectives', entity: 'quality_objective', prefix: 'QO-', shared: false, linkByCode: false, ownerRequired: true,
    fields: ['statement', 'targetText', 'metricCode', 'dueAt', 'resources', 'evaluationMethod', 'objectiveStatus', 'result', 'achievedAt'],
  },
  'competence': {
    id: 'competence', entity: 'competence_record', prefix: null, shared: true, linkByCode: false, ownerRequired: true,
    fields: ['personHandle', 'competenceRequired', 'proofType', 'proofObjectId', 'achievedAt', 'validUntil', 'verifiedByHandle'],
  },
};

/** Fields a Risk Owner may change on own risks (F.6 `risk.manage` own: the assessment fields; RISK_ASSESSMENT_KEYS). */
export const RISK_ASSESSMENT_FIELDS: readonly FieldKey[] = [
  'likelihood', 'consequence', 'residualLikelihood', 'residualConsequence', 'treatmentOption', 'assessedAt', 'nextReviewAt',
];

/** The role of a competence record has at most 150 characters (M2-07, `COMPETENCE_ROLE_MAX`). */
export const COMPETENCE_ROLE_MAX = 150;
/** The owner of a competence record is reminded this many days before `validUntil` (M2-07). */
export const COMPETENCE_REMINDER_DAYS = 30;

/** Likelihood and impact scales of the risk profiles of every pack (1 to 5); the server checks the profile in use. */
export const SCORE_SCALE = { min: 1, max: 5 } as const;

/** The code of a competence record: `CMP-` and the first 8 hex digits of its id in upper case (M2-07 deviation 3). */
export function competenceCode(id: string): string {
  return `CMP-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** A row of a register as the screen shows it: the api's `RegisterItem` with its uuid and ETag. */
export type RowModel = Omit<RegisterItem, 'ref'> & {
  id: string;
  etag: string | null;
  /** Sample build only: the name of the proof file. */
  proofName?: string | null;
};

/** The longest search `registers.list` takes (`RegisterListQuery.q`, 100 characters). */
export const SEARCH_MAX = 100;

export interface ListQuery {
  q?: string;
  page: number;
  pageSize: number;
}

export interface RowPage {
  items: RowModel[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Treatments (C.13 `risk_treatment.status`)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The status of a treatment as far as the screen knows it. The api has no list of treatments with their status: the
 * screen reads them as chain records of the risk (`readmodel.audit.stage-records`), whose pending action tells the
 * open status (`open` when the action text is not one of the server's), and `done` stands for implemented, residual
 * accepted or closed (no pending action). A move made on screen is known exactly.
 */
export type TreatmentState = TreatmentStatus | 'open' | 'done';

export interface TreatmentModel {
  id: string;
  code: string;
  title: string;
  owner: string;
  /** Target date (or the due date of its pending action). */
  due: string | null;
  /** Code of the control or requirement it targets. */
  target: string | null;
  status: TreatmentState;
  etag: string | null;
  /** Who moved it to implemented, when known. */
  implementedBy: string | null;
}

/** The pending action texts of the server per status (`TREATMENT_ACTIONS` of treatments.service.ts). */
export const TREATMENT_ACTIONS: Readonly<Record<TreatmentStatus, string | null>> = {
  proposed: 'Approve the treatment',
  approved: 'Start the implementation',
  in_progress: 'Report implementation progress',
  delayed: 'Report implementation progress: the target date has passed',
  implemented: null,
  residual_accepted: null,
  closed: null,
};

/** The status a pending action stands for. */
export function statusFromAction(action: string | null | undefined): TreatmentState {
  if (action === null || action === undefined || action === '') return 'done';
  for (const [status, text] of Object.entries(TREATMENT_ACTIONS)) if (text === action) return status as TreatmentStatus;
  return 'open';
}

export type MoveTarget = 'approved' | 'in_progress' | 'delayed' | 'implemented' | 'closed';

/** The C.13 moves the screen offers from a status (rework to proposed is left to the api). */
export function movesFrom(status: TreatmentState): MoveTarget[] {
  switch (status) {
    case 'proposed': return ['approved'];
    case 'approved': return ['in_progress'];
    case 'in_progress': return ['delayed', 'implemented'];
    case 'delayed': return ['in_progress', 'implemented'];
    case 'implemented': return ['closed'];
    case 'residual_accepted': return ['closed'];
    case 'open': return ['approved', 'in_progress', 'delayed', 'implemented'];
    case 'done': return ['closed'];
    default: return [];
  }
}

/** The button label of a move. */
export function moveLabel(from: TreatmentState, to: MoveTarget): TextPair {
  if (to === 'approved') return TEXT.moveApprove;
  if (to === 'in_progress') return from === 'delayed' ? TEXT.moveResume : TEXT.moveStart;
  if (to === 'delayed') return TEXT.moveDelay;
  if (to === 'implemented') return TEXT.moveImplement;
  return TEXT.moveClose;
}

/** Approving and closing need `risk.manage` in full; starting, delaying and implementing `risk.treatment.update` (own). */
export const MOVE_PERMISSION: Readonly<Record<MoveTarget, 'risk.manage' | 'risk.treatment.update'>> = {
  approved: 'risk.manage',
  closed: 'risk.manage',
  in_progress: 'risk.treatment.update',
  delayed: 'risk.treatment.update',
  implemented: 'risk.treatment.update',
};

/** Why a move is not offered now, or null: closing waits for the residual acceptance (BR-04). */
export function moveBlock(t: TreatmentModel, to: MoveTarget): TextPair | null {
  if (to === 'closed' && t.status === 'implemented') return TEXT.closeBlocked;
  return null;
}

/** Treatments the risk owner can accept the residual risk of: implemented, or done when the status is not known. */
export function acceptCandidates(treatments: readonly TreatmentModel[]): TreatmentModel[] {
  const implemented = treatments.filter((t) => t.status === 'implemented');
  return implemented.length ? implemented : treatments.filter((t) => t.status === 'done');
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Business roles that hold the register permissions in full (F.6): `register.manage`, `metric.record`, `risk.manage`,
 * `risk.treatment.update` and `entity_link.manage` are MS Manager rows; Domain Owners and Risk Owners hold some of them
 * for own records only. test/screens/registers.test.tsx checks these against the shared matrix.
 */
export const FULL_ROLES: Readonly<Record<'register.manage' | 'metric.record' | 'risk.manage' | 'risk.treatment.update' | 'entity_link.manage', readonly string[]>> = {
  'register.manage': ['ms_manager'],
  'metric.record': ['ms_manager'],
  'risk.manage': ['ms_manager'],
  'risk.treatment.update': ['ms_manager'],
  'entity_link.manage': ['ms_manager'],
};

/** The handle of the session person. */
export function meOf(ctx: Pick<HostContext, 'person' | 'me'>): string {
  return ctx.me?.user?.handle ?? ctx.person.handle;
}

/** True when the session holds the permission in full in the system (not only for own records). */
export function holdsInFull(ctx: Pick<HostContext, 'can' | 'me' | 'mode' | 'role'>, ms: MsId, perm: keyof typeof FULL_ROLES): boolean {
  if (!ctx.can(ms, perm)) return false;
  if (ctx.mode !== 'api') return ctx.role === 'manager';
  const roles = ctx.me?.rolesByMs?.[ms] ?? [];
  return roles.some((r) => FULL_ROLES[perm].includes(r));
}

type Ctx = Pick<HostContext, 'can' | 'me' | 'mode' | 'role' | 'person'>;

/** True when the session may add records of the kind (risks: `risk.manage` in full; others `register.manage`, own rows). */
export function canAdd(ctx: Ctx, ms: MsId, kind: RegisterKind): boolean {
  if (kind === 'risks') return holdsInFull(ctx, ms, 'risk.manage');
  return ctx.can(ms, 'register.manage');
}

/** True when an added record must have the session person as its owner (own-scoped `register.manage`). */
export function ownerFixed(ctx: Ctx, ms: MsId, kind: RegisterKind): boolean {
  return kind !== 'risks' && !holdsInFull(ctx, ms, 'register.manage');
}

/** How the session may change a row: every field, the assessment fields of an own risk, or not at all. */
export function editScope(ctx: Ctx, ms: MsId, kind: RegisterKind, row: Pick<RowModel, 'owner'>): 'all' | 'assessment' | 'own' | null {
  const perm = kind === 'risks' ? 'risk.manage' : 'register.manage';
  if (!ctx.can(ms, perm)) return null;
  if (holdsInFull(ctx, ms, perm)) return 'all';
  if (row.owner !== meOf(ctx)) return null;
  return kind === 'risks' ? 'assessment' : 'own';
}

export function canRecordValue(ctx: Ctx, ms: MsId, row: Pick<RowModel, 'owner'>): boolean {
  return ctx.can(ms, 'metric.record') && (holdsInFull(ctx, ms, 'metric.record') || row.owner === meOf(ctx));
}

/** Adding a treatment, approving and closing: `risk.manage` in full. */
export function canManageTreatments(ctx: Ctx, ms: MsId): boolean {
  return holdsInFull(ctx, ms, 'risk.manage');
}

/** Whether the session may make a move of a treatment. */
export function canMove(ctx: Ctx, ms: MsId, t: Pick<TreatmentModel, 'owner'>, to: MoveTarget): boolean {
  const perm = MOVE_PERMISSION[to];
  if (perm === 'risk.manage') return canManageTreatments(ctx, ms);
  return ctx.can(ms, perm) && (holdsInFull(ctx, ms, perm) || t.owner === meOf(ctx));
}

/**
 * Whether the session may accept the residual risk now, or why not (`risk.residual.accept`: the risk's owner, never
 * the implementer, BR-04). The screen knows the implementer of a move made on it (and the sample does); otherwise the
 * api has the last word and its BR-04 refusal shows in the form.
 */
export function acceptBlock(ctx: HostContext, ms: MsId, risk: Pick<RowModel, 'owner'>, candidates: readonly TreatmentModel[], chosen: string | null): TextPair | string | null {
  if (!ctx.can(ms, 'risk.residual.accept') || risk.owner !== meOf(ctx)) {
    return ctx.fill(TEXT.onlyOwnerAccepts, { name: personName(ctx, risk.owner) });
  }
  if (!candidates.length) return TEXT.noImplemented;
  const t = chosen ? candidates.find((c) => c.id === chosen) : candidates.length === 1 ? candidates[0] : null;
  if (t && t.implementedBy === meOf(ctx)) return TEXT.implementerBlocked;
  return null;
}

/** Linking to another system: `entity_link.manage` in that system (feature `integrated_mode`). */
export function linkTargets(ctx: HostContext, row: Pick<RowModel, 'ms'>): { id: MsId; label: string }[] {
  return (ctx.D?.MS ?? [])
    .filter((m) => !row.ms.includes(m.id) && ctx.can(m.id, 'entity_link.manage'))
    .map((m) => ({ id: m.id, label: m.short || m.code }));
}

/** Making another system primary and removing a link change `linkedMs`: the kind's manage permission in full here. */
export function canChangeLinks(ctx: Ctx, ms: MsId, kind: RegisterKind): boolean {
  return holdsInFull(ctx, ms, kind === 'risks' ? 'risk.manage' : 'register.manage') && ctx.can(ms, 'entity_link.manage');
}

// ---------------------------------------------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------------------------------------------

export function personName(ctx: Pick<HostContext, 'D' | 'li'>, handle: string | null | undefined): string {
  if (!handle || handle === 'none') return ctx.li(TEXT.unassigned);
  return ctx.D?.PEOPLE?.[handle]?.[0] ?? handle;
}

/** The short name of a system. */
export function systemName(ctx: Pick<HostContext, 'D'>, ms: MsId): string {
  const m = ctx.D?.MS?.find((s) => s.id === ms);
  return m ? m.short || m.code : ms.toUpperCase();
}

export function formatDate(ctx: Pick<HostContext, 'D' | 'lang'>, date: string | null | undefined): string {
  if (!date) return '-';
  return ctx.D && typeof ctx.D.fmt === 'function' ? ctx.D.fmt(date, ctx.lang) : date;
}

/** Likelihood times impact, or null when one of them is not set. */
export function scoreOf(l: number | null | undefined, c: number | null | undefined): number | null {
  return typeof l === 'number' && typeof c === 'number' ? l * c : null;
}

/** Tone of a score on the 1 to 5 scales: 15 and above high, 8 and above medium. */
export function scoreTone(score: number | null): 'bad' | 'warn' | 'ok' | 'mute' {
  if (score === null) return 'mute';
  if (score >= 15) return 'bad';
  if (score >= 8) return 'warn';
  return 'ok';
}

/** The state of a competence record's validity on `today`: expired, renew within 30 days, or fine. */
export function validityOf(validUntil: string | null | undefined, today: string | null | undefined): 'expired' | 'soon' | null {
  if (!validUntil || !today) return null;
  if (validUntil < today) return 'expired';
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + COMPETENCE_REMINDER_DAYS);
  return validUntil <= d.toISOString().slice(0, 10) ? 'soon' : null;
}

/** The label of a value of a select field. */
export function valueLabel(field: FieldKey, value: unknown): TextPair | string {
  if (value === null || value === undefined || value === '') return TEXT.noValue;
  const options = FIELDS[field].options;
  const pair = options?.[String(value)];
  return pair ?? String(value);
}

/** The next free code with a prefix, after the highest number among `codes` (R-031 gives R-032). */
export function nextCode(prefix: string, codes: readonly string[]): string {
  let max = 0;
  let width = 3;
  for (const code of codes) {
    if (!code.startsWith(prefix)) continue;
    const m = /^(\d+)$/.exec(code.slice(prefix.length));
    if (!m) continue;
    width = Math.max(width, m[1].length);
    max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(width, '0');
}

/** The kind's label pairs. */
export function kindLabel(kind: RegisterKind): TextPair {
  return KIND_TEXT[kind].label;
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

/** Form values: text for every field (empty is not set), booleans for checkboxes. */
export type FormState = Record<string, string | boolean>;
export type FormErrors = Partial<Record<string, TextPair | string>>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** An empty form of a kind. */
export function emptyForm(kind: RegisterKind, codes: readonly string[], me: string, today: string | null): FormState {
  const def = KIND_DEFS[kind];
  const form: FormState = { code: def.prefix ? nextCode(def.prefix, codes) : '', title: '', ownerHandle: kind === 'risks' ? '' : me };
  for (const key of def.fields) form[key] = FIELDS[key].type === 'bool' ? false : '';
  if (kind === 'risks' && today) form.assessedAt = today;
  if (kind === 'objectives') form.objectiveStatus = 'planned';
  if (kind === 'context-issues') form.issueType = 'internal';
  if (kind === 'competence') form.proofType = 'certificate';
  return form;
}

/** The form of an existing row. */
export function formOfRow(kind: RegisterKind, row: RowModel): FormState {
  const form: FormState = { code: row.code, title: row.title, ownerHandle: row.owner === 'none' ? '' : row.owner };
  const values = row as unknown as Record<string, unknown>;
  for (const key of KIND_DEFS[kind].fields) form[key] = FIELDS[key].type === 'bool' ? Boolean(values[key]) : str(values[key]);
  return form;
}

const CODE_PATTERN = /^\S(?:.*\S)?$/;

/** Problems of a form before it is sent; the api checks everything again. */
export function formErrors(kind: RegisterKind, form: FormState): FormErrors {
  const errors: FormErrors = {};
  const def = KIND_DEFS[kind];
  const text = (k: string) => str(form[k]).trim();
  if (def.prefix) {
    if (!text('code')) errors.code = TEXT.required;
    else if (text('code').length > 30 || !CODE_PATTERN.test(text('code'))) errors.code = TEXT.badCode;
  }
  const titleMax = kind === 'competence' ? COMPETENCE_ROLE_MAX : 255;
  if (!text('title')) errors.title = TEXT.required;
  else if (text('title').length > titleMax) errors.title = fillMax(titleMax);
  if (def.ownerRequired && (!text('ownerHandle') || text('ownerHandle') === 'none')) errors.ownerHandle = TEXT.required;
  for (const key of def.fields) {
    const f = FIELDS[key];
    const v = text(key);
    if (f.required && !v && f.type !== 'proof') errors[key] = TEXT.required;
    else if (f.max && v.length > f.max) errors[key] = fillMax(f.max);
    else if (f.type === 'number' && v && !Number.isFinite(Number(v))) errors[key] = TEXT.badNumber;
  }
  if (kind === 'competence' && text('achievedAt') && text('validUntil') && text('validUntil') < text('achievedAt')) errors.validUntil = TEXT.validBeforeAchieved;
  return errors;
}

function fillMax(n: number): TextPair {
  return [TEXT.tooLong[0].replace('{n}', String(n)), TEXT.tooLong[1].replace('{n}', String(n))];
}

/** The wire value of a field: numbers for scores and numbers, booleans, handles, null for an empty field. */
function wire(key: FieldKey, value: string | boolean): unknown {
  const f = FIELDS[key];
  if (f.type === 'bool') return Boolean(value);
  const v = String(value).trim();
  if (!v) return null;
  if (f.type === 'score') return Number.parseInt(v, 10);
  if (f.type === 'number') return Number(v);
  return v;
}

/** Fields the server takes only when they are set (they are never null on the wire). */
const NOT_NULLABLE: ReadonlySet<FieldKey> = new Set(['personHandle', 'competenceRequired', 'proofType', 'isOpportunity']);

/** `RegisterCreate` of a form: set fields only; `ownerHandle` the session person when the owner is fixed. */
export function createBody(kind: RegisterKind, form: FormState, opts: { ownerFixed: boolean; me: string; proofObjectId?: string | null }): RegisterCreate {
  const body: Record<string, unknown> = { title: str(form.title).trim() };
  if (KIND_DEFS[kind].prefix) body.code = str(form.code).trim();
  // An empty owner of a register that takes none is unassigned (`none`); without `ownerHandle` the api makes the caller the owner.
  body.ownerHandle = opts.ownerFixed ? opts.me : str(form.ownerHandle).trim() || 'none';
  for (const key of KIND_DEFS[kind].fields) {
    if (key === 'proofObjectId') continue;
    const value = wire(key, form[key] ?? '');
    if (value === null || (FIELDS[key].type === 'bool' && value === false)) continue;
    body[key] = value;
  }
  if (opts.proofObjectId) body.proofObjectId = opts.proofObjectId;
  return body as RegisterCreate;
}

/**
 * `RegisterPatch` of the fields that changed, or null when nothing did. `scope` limits it: a Risk Owner changes the
 * assessment fields of own risks only, and an own-row editor keeps the owner.
 */
export function patchBody(kind: RegisterKind, form: FormState, row: RowModel, scope: 'all' | 'assessment' | 'own', proofObjectId?: string | null): RegisterPatch | null {
  const patch: Record<string, unknown> = {};
  const values = row as unknown as Record<string, unknown>;
  const allowed = (key: string) => scope !== 'assessment' || (RISK_ASSESSMENT_FIELDS as readonly string[]).includes(key);
  if (allowed('code') && KIND_DEFS[kind].prefix && str(form.code).trim() !== row.code) patch.code = str(form.code).trim();
  if (allowed('title') && str(form.title).trim() !== row.title) patch.title = str(form.title).trim();
  if (scope === 'all') {
    const owner = str(form.ownerHandle).trim() || 'none';
    if (owner !== row.owner) patch.ownerHandle = owner;
  }
  for (const key of KIND_DEFS[kind].fields) {
    if (!allowed(key) || key === 'proofObjectId') continue;
    const next = wire(key, form[key] ?? '');
    const current = values[key] === undefined ? null : values[key];
    const same = FIELDS[key].type === 'bool' ? Boolean(next) === Boolean(current) : (next ?? null) === (current === '' ? null : current);
    if (same) continue;
    if (next === null && NOT_NULLABLE.has(key)) continue;
    patch[key] = next;
  }
  if (proofObjectId && proofObjectId !== row.proofObjectId) patch.proofObjectId = proofObjectId;
  return Object.keys(patch).length ? (patch as RegisterPatch) : null;
}

/** Problems of a metric value before it is sent. */
export function valueErrors(form: { periodStart: string; periodEnd: string; value: string; note: string }): FormErrors {
  const errors: FormErrors = {};
  if (!form.periodStart) errors.periodStart = TEXT.required;
  if (!form.periodEnd) errors.periodEnd = TEXT.required;
  if (form.periodStart && form.periodEnd && form.periodEnd < form.periodStart) errors.periodEnd = TEXT.periodOrder;
  if (!form.value.trim()) errors.value = TEXT.required;
  else if (!Number.isFinite(Number(form.value))) errors.value = TEXT.badNumber;
  if (form.note.length > 1000) errors.note = fillMax(1000);
  return errors;
}

export function valueBody(form: { periodStart: string; periodEnd: string; value: string; note: string }): MetricValueRequest {
  return { periodStart: form.periodStart, periodEnd: form.periodEnd, value: Number(form.value), ...(form.note.trim() ? { note: form.note.trim() } : {}) };
}

export interface TreatmentForm {
  option: string;
  code: string;
  title: string;
  owner: string;
  due: string;
  target: string;
}

export function treatmentErrors(form: TreatmentForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.code.trim()) errors.code = TEXT.required;
  else if (form.code.trim().length > 30 || !CODE_PATTERN.test(form.code.trim())) errors.code = TEXT.badCode;
  if (!form.title.trim()) errors.title = TEXT.required;
  else if (form.title.trim().length > 255) errors.title = fillMax(255);
  if (!form.owner || form.owner === 'none') errors.owner = TEXT.required;
  if (!form.due) errors.due = TEXT.required;
  if (!form.target) errors.target = TEXT.required;
  return errors;
}

/** A control or requirement a treatment can target (`applicability.targets`). */
export interface TargetOption {
  kind: 'catalogue_item' | 'requirement';
  code: string;
  title: string;
}

export function treatmentBody(risk: Pick<RowModel, 'code'>, form: TreatmentForm, targets: readonly TargetOption[]): TreatmentCreate {
  const target = targets.find((t) => t.code === form.target);
  return {
    riskCode: risk.code, code: form.code.trim(), title: form.title.trim(), ownerHandle: form.owner,
    targetType: target?.kind ?? 'catalogue_item', targetCode: form.target, targetDate: form.due,
  };
}

export interface ResidualForm {
  treatmentId: string;
  likelihood: string;
  consequence: string;
  note: string;
}

export function residualErrors(form: ResidualForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.likelihood) errors.likelihood = TEXT.required;
  if (!form.consequence) errors.consequence = TEXT.required;
  if (!form.note.trim()) errors.note = TEXT.required;
  else if (form.note.trim().length > 2000) errors.note = fillMax(2000);
  return errors;
}

export function residualBody(form: ResidualForm): ResidualAcceptanceRequest {
  return {
    ...(form.treatmentId ? { treatmentId: form.treatmentId } : {}),
    residualLikelihood: Number.parseInt(form.likelihood, 10),
    residualConsequence: Number.parseInt(form.consequence, 10),
    note: form.note.trim(),
  };
}

/** The systems of `linkedMs` after making `ms` primary (it goes first) or removing it. */
export function linkedAfter(row: Pick<RowModel, 'ms'>, ms: MsId, change: 'primary' | 'remove'): MsId[] {
  if (change === 'remove') return row.ms.filter((m) => m !== ms);
  return [ms, ...row.ms.filter((m) => m !== ms)];
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------------------------------------------

/** An evidence record the proof file of a competence record can be kept with. */
export interface ProofHolder {
  id: string;
  code: string;
  title: string;
  /** The record has a file now, which the proof file replaces (`evidence.files`). */
  hasFile: boolean;
}

/**
 * True for the requirement or control of an evidence record that keeps competence proofs: clause 7.2 Competence (and
 * 7.2.1 of ISO 37001) or control A.6.3 of ISO/IEC 27001 (awareness, education and training). Control A.7.2 (physical
 * entry) shares the number of the clause and is left out.
 */
export function keepsCompetenceProof(ctrl: string | null | undefined): boolean {
  const code = String(ctrl ?? '').trim();
  return /^(?:Cl\.\s*|cl-)?7\.2(?:\.1)?$/i.test(code) || code === 'A.6.3';
}

/**
 * The evidence records of a system that may keep a competence proof (`keepsCompetenceProof`), those without a file
 * first. Any other evidence record would get a person's certificate as its current file, so it is never offered.
 */
export function proofHoldersOf(evs: readonly { code: string; title: string; ctrl?: string | null; loc?: string | null }[], idOf: (code: string) => string): ProofHolder[] {
  return evs
    .filter((e) => keepsCompetenceProof(e.ctrl))
    .map((e) => ({ id: idOf(e.code), code: e.code, title: e.title, hasFile: Boolean(e.loc) }))
    .filter((h) => h.id)
    .sort((a, b) => Number(a.hasFile) - Number(b.hasFile) || a.code.localeCompare(b.code));
}

export interface RegistersAdapter {
  /** True for the sample build (changes stay in the browser session). */
  readonly sample: boolean;
  list(ms: MsId, kind: RegisterKind, query: ListQuery): Promise<Result<RowPage>>;
  create(ms: MsId, kind: RegisterKind, body: RegisterCreate, idempotencyKey: string): Promise<Result<Outcome>>;
  update(ms: MsId, kind: RegisterKind, row: RowModel, patch: RegisterPatch): Promise<Result<Outcome>>;
  recordValue(ms: MsId, row: RowModel, body: MetricValueRequest, idempotencyKey: string): Promise<Result<Outcome>>;
  treatments(ms: MsId, risk: RowModel): Promise<Result<TreatmentModel[]>>;
  addTreatment(ms: MsId, risk: RowModel, body: TreatmentCreate, idempotencyKey: string): Promise<Result<Outcome>>;
  moveTreatment(ms: MsId, risk: RowModel, treatment: TreatmentModel, to: MoveTarget): Promise<Result<Outcome>>;
  acceptResidual(ms: MsId, risk: RowModel, body: ResidualAcceptanceRequest, idempotencyKey: string): Promise<Result<Outcome>>;
  /** Links a record to another system (`entity-links.create` in that system, or `linkedMs` for competence). */
  link(ms: MsId, kind: RegisterKind, row: RowModel, target: MsId, note: string): Promise<Result<Outcome>>;
  targets(ms: MsId): Promise<Result<TargetOption[]>>;
  /** The codes of every treatment of the system (treatment codes are unique per system), for the suggested code. */
  treatmentCodes(ms: MsId): Promise<Result<string[]>>;
  /** Evidence records of the system that a proof file can be kept with (`proofHoldersOf`). */
  proofHolders(ms: MsId): ProofHolder[];
  /** Attaches a picked file to an evidence record and answers its stored object id. */
  attachProof(ms: MsId, holder: ProofHolder, file: PickedFile): Promise<Result<{ storageObjectId: string; fileName: string }>>;
  /** A short-lived link to open a stored proof file; null in the sample build. */
  openProof(ms: MsId, row: RowModel): Promise<Result<string | null>>;
}

/** `Outcome` of a sample or api command result. */
export function outcomeOf(result: { changed?: readonly string[]; message?: readonly [string, string] | null; warnings?: readonly { messages?: { en: string; id: string }; message?: readonly [string, string] }[]; ref?: { id: string; code: string; etag?: string } | null; data?: unknown }): Outcome {
  const warnings = (result.warnings ?? []).map((w): TextPair => (w.messages ? [w.messages.en, w.messages.id] : w.message ? [w.message[0], w.message[1]] : ['', '']));
  return {
    message: result.message ? [result.message[0], result.message[1]] : null,
    warnings: warnings.filter((w) => w[0]),
    changed: [...(result.changed ?? [])],
    ref: result.ref ? { id: result.ref.id, code: result.ref.code, ...(result.ref.etag ? { etag: result.ref.etag } : {}) } : null,
    data: result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : null,
  };
}
