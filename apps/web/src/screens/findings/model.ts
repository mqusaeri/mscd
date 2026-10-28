// The view model of "Findings and actions" (MILESTONE-2 M2-14) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6). The Internal audit screen uses
// the same adapter to raise a finding from an audit and to list the findings of an audit.
//
// Audit terms in plain words: a finding is something an audit found; a nonconformity (major or minor) means a
// requirement is not met, an opportunity for improvement (OFI) is advice. A corrective action removes the cause of a
// nonconformity in five steps: correction (fix the problem now), root cause analysis, systemic check (could it happen
// elsewhere), action (remove the cause) and the effectiveness check by someone else (BR-09). The self-assessment checks
// the system against the finding conditions of the standard's pack before an auditor does.
import type { MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import type { Outcome, Result } from './shared';
import { filled, mayActOn, meOf } from './shared';
import { TEXT } from './text';

// Enum values of @mscd/shared (enums.ts), repeated here because the web bundle imports only types from it (R-17).
export const CLASSIFICATIONS = ['major', 'minor', 'ofi', 'signal', 'not_a_finding'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const SOURCES = ['certification_audit', 'internal_audit', 'self_assessment', 'other'] as const;
export type FindingSource = (typeof SOURCES)[number];
export const FINDING_STATUSES = ['open', 'in_progress', 'closed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const CA_STATUSES = ['correction', 'rca', 'systemic_check', 'action', 'effectiveness_verification', 'closed', 'cancelled'] as const;
export type CaStatus = (typeof CA_STATUSES)[number];
export const SA_STATUSES = ['not_assessed', 'conforming', 'gap', 'not_applicable'] as const;
export type SaStatus = (typeof SA_STATUSES)[number];

export const CLASSIFICATION_TEXT: Readonly<Record<Classification, TextPair>> = {
  major: TEXT.major,
  minor: TEXT.minor,
  ofi: TEXT.ofi,
  signal: TEXT.signal,
  not_a_finding: TEXT.notAFinding,
};
export const CLASSIFICATION_TONE: Readonly<Record<Classification, Tone>> = { major: 'bad', minor: 'warn', ofi: 'info', signal: 'mute', not_a_finding: 'mute' };
export const SOURCE_TEXT: Readonly<Record<FindingSource, TextPair>> = {
  certification_audit: TEXT.srcCertification,
  internal_audit: TEXT.srcInternal,
  self_assessment: TEXT.srcSelf,
  other: TEXT.srcOther,
};
export const FINDING_STATUS_TEXT: Readonly<Record<FindingStatus, TextPair>> = { open: TEXT.stOpen, in_progress: TEXT.stInProgress, closed: TEXT.stClosed };
export const FINDING_STATUS_TONE: Readonly<Record<FindingStatus, Tone>> = { open: 'warn', in_progress: 'info', closed: 'ok' };
export const CA_STATUS_TEXT: Readonly<Record<CaStatus, TextPair>> = {
  correction: TEXT.caCorrection,
  rca: TEXT.caRca,
  systemic_check: TEXT.caSystemic,
  action: TEXT.caAction,
  effectiveness_verification: TEXT.caVerification,
  closed: TEXT.stClosed,
  cancelled: TEXT.caCancelled,
};
export const CA_STATUS_TONE: Readonly<Record<CaStatus, Tone>> = {
  correction: 'warn', rca: 'warn', systemic_check: 'warn', action: 'info', effectiveness_verification: 'acc', closed: 'ok', cancelled: 'mute',
};
export const SA_STATUS_TEXT: Readonly<Record<SaStatus, TextPair>> = {
  not_assessed: TEXT.saNotAssessed,
  conforming: TEXT.saConforming,
  gap: TEXT.saGap,
  not_applicable: TEXT.saNotApplicable,
};
export const SA_STATUS_TONE: Readonly<Record<SaStatus, Tone>> = { not_assessed: 'mute', conforming: 'ok', gap: 'bad', not_applicable: 'mute' };

/** The four working steps of a corrective action in order; each step is left with its text (C.13). */
export const CA_STEPS: readonly { status: CaStatus; next: CaStatus; text: TextPair; hint: TextPair; field: 'correctionText' | 'rcaText' | 'systemicCheckText' | 'actionText' }[] = [
  { status: 'correction', next: 'rca', text: TEXT.caCorrection, hint: TEXT.caCorrectionHint, field: 'correctionText' },
  { status: 'rca', next: 'systemic_check', text: TEXT.caRca, hint: TEXT.caRcaHint, field: 'rcaText' },
  { status: 'systemic_check', next: 'action', text: TEXT.caSystemic, hint: TEXT.caSystemicHint, field: 'systemicCheckText' },
  { status: 'action', next: 'effectiveness_verification', text: TEXT.caAction, hint: TEXT.caActionHint, field: 'actionText' },
];

export interface FindingModel {
  id: string;
  code: string;
  title: string;
  classification: Classification;
  source: FindingSource;
  clauseRef: string | null;
  targetCode: string | null;
  status: FindingStatus;
  /** Handle; `none` when unassigned or hidden from Top Management (F.7). */
  owner: string;
  raisedAt: string | null;
  dueAt: string | null;
  auditEvent: { id: string; shortLabel: string } | null;
  actions: { id: string; code: string; status: CaStatus }[];
  etag: string | null;
  /** The texts of the finding when the source gives them (the sample; the api once FindingItem carries them). */
  rcaText?: string | null;
  systemicCheckText?: string | null;
  statusNote?: string | null;
}

export interface ActionModel {
  id: string;
  code: string;
  title: string;
  status: CaStatus;
  owner: string;
  dueAt: string | null;
  correctionText: string | null;
  rcaText: string | null;
  systemicCheckText: string | null;
  actionText: string | null;
  implementedAt: string | null;
  implementedBy: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  effective: boolean | null;
  findings: { id: string; code: string }[];
  etag: string | null;
}

export interface SelfRow {
  /** Uuid of the stored assessment; null while the condition is not assessed. */
  id: string | null;
  conditionCode: string;
  classification: Classification;
  requirementCode: string | null;
  text: string;
  status: SaStatus;
  owner: string | null;
  targetFixAt: string | null;
  note: string | null;
  assessedAt: string | null;
  evidence: string[];
  findingCode: string | null;
}

/** A clause or control of the system's edition (`applicability.targets`). */
export interface TargetOption {
  code: string;
  title: string;
  kind: 'catalogue_item' | 'requirement';
}

/** An audit event a finding can name. */
export interface EventOption {
  id: string;
  shortLabel: string;
  scheduledAt: string;
  eventType: string;
}

export interface FindingQuery {
  targetCode?: string;
}

export interface RaiseBody {
  code: string;
  title: string;
  classification: Classification;
  source: FindingSource;
  clauseRef?: string;
  targetCode?: string;
  auditEventId?: string;
  ownerHandle: string;
  dueAt?: string;
}

export interface FindingPatchBody {
  title?: string;
  classification?: Classification;
  clauseRef?: string | null;
  targetCode?: string | null;
  ownerHandle?: string;
  dueAt?: string | null;
  rcaText?: string | null;
  systemicCheckText?: string | null;
}

export interface FindingMove {
  to: 'in_progress' | 'closed';
  note?: string;
}

export interface ActionCreateBody {
  findingIds: string[];
  code: string;
  title: string;
  ownerHandle: string;
  dueAt?: string;
}

export interface ActionPatchBody {
  title?: string;
  ownerHandle?: string;
  dueAt?: string | null;
  findingIds?: string[];
}

export interface ActionMove {
  to: CaStatus;
  text?: string;
  effective?: boolean;
  note?: string;
}

export interface AssessBody {
  status: SaStatus;
  ownerHandle?: string;
  targetFixAt?: string;
  note?: string;
  evidenceCodes: string[];
}

export interface FindingsAdapter {
  readonly sample: boolean;
  findings(ms: MsId, query?: FindingQuery): Promise<Result<FindingModel[]>>;
  raise(ms: MsId, body: RaiseBody, idempotencyKey: string): Promise<Result<Outcome>>;
  update(ms: MsId, finding: FindingModel, patch: FindingPatchBody): Promise<Result<Outcome>>;
  move(ms: MsId, finding: FindingModel, body: FindingMove): Promise<Result<Outcome>>;
  actions(ms: MsId): Promise<Result<ActionModel[]>>;
  createAction(ms: MsId, body: ActionCreateBody, idempotencyKey: string): Promise<Result<Outcome>>;
  updateAction(ms: MsId, action: ActionModel, patch: ActionPatchBody): Promise<Result<Outcome>>;
  moveAction(ms: MsId, action: ActionModel, body: ActionMove): Promise<Result<Outcome>>;
  selfAssessment(ms: MsId): Promise<Result<SelfRow[]>>;
  assess(ms: MsId, row: SelfRow, body: AssessBody): Promise<Result<Outcome>>;
  raiseFromGap(ms: MsId, row: SelfRow, body: { classification: Classification; title?: string }, idempotencyKey: string): Promise<Result<Outcome>>;
  targets(ms: MsId): Promise<Result<TargetOption[]>>;
  events(ms: MsId): Promise<Result<EventOption[]>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6 through the host context)
// ---------------------------------------------------------------------------------------------------------------

export const mayRaise = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'finding.raise');
export const mayManageFinding = (ctx: Pick<HostContext, 'can'>, ms: MsId): boolean => ctx.can(ms, 'finding.manage');
export const mayCreateAction = (ctx: Pick<HostContext, 'can'>, ms: MsId): boolean => ctx.can(ms, 'corrective_action.manage');
export const mayAssess = (ctx: Pick<HostContext, 'can'>, ms: MsId): boolean => ctx.can(ms, 'self_assessment.manage');

/** True when the session may record the next step of a corrective action: manage, or update in full or as its owner. */
export function mayStep(ctx: Pick<HostContext, 'can' | 'me' | 'mode' | 'role' | 'person'>, ms: MsId, action: Pick<ActionModel, 'owner'>): boolean {
  return ctx.can(ms, 'corrective_action.manage') || mayActOn(ctx, ms, 'corrective_action.update', action.owner);
}

/**
 * Why the session may not check the effectiveness of a corrective action, or null when it may: the permission
 * (`corrective_action.verify`), and BR-09 (the implementer and the owner never verify their own action).
 */
export function verifyBlock(ctx: Pick<HostContext, 'can' | 'me' | 'person'>, ms: MsId, action: Pick<ActionModel, 'owner' | 'implementedBy'>): TextPair | null {
  if (!ctx.can(ms, 'corrective_action.verify')) return TEXT.verifyNoRight;
  const me = meOf(ctx);
  if (action.implementedBy === me) return TEXT.verifyImplementer;
  if (action.owner === me) return TEXT.verifyOwner;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface RaiseForm {
  code: string;
  title: string;
  classification: Classification | '';
  source: FindingSource;
  clauseRef: string;
  targetCode: string;
  auditEventId: string;
  owner: string;
  dueAt: string;
}

/** Where the raise form starts: a source and audit event when raised from an audit. */
export interface RaisePrefill {
  source?: FindingSource;
  auditEventId?: string;
  targetCode?: string;
}

export const CODE_PREFIX: Readonly<Record<FindingSource, string>> = { internal_audit: 'IA', certification_audit: 'NC', self_assessment: 'SA', other: 'F' };

export function emptyRaise(prefill: RaisePrefill = {}): RaiseForm {
  return {
    code: '',
    title: '',
    classification: '',
    source: prefill.source ?? 'internal_audit',
    clauseRef: '',
    targetCode: prefill.targetCode ?? '',
    auditEventId: prefill.auditEventId ?? '',
    owner: '',
    dueAt: '',
  };
}

export type FormErrors<K extends string> = Partial<Record<K, TextPair>>;

const CODE_PATTERN = /^\S(?:.*\S)?$/;

export function raiseErrors(form: RaiseForm, codes: readonly string[]): FormErrors<keyof RaiseForm> {
  const out: FormErrors<keyof RaiseForm> = {};
  if (!filled(form.code)) out.code = TEXT.required;
  else if (form.code.trim().length > 30 || !CODE_PATTERN.test(form.code.trim())) out.code = TEXT.badCode;
  else if (codes.includes(form.code.trim())) out.code = TEXT.codeTaken;
  if (!filled(form.title)) out.title = TEXT.required;
  else if (form.title.trim().length > 255) out.title = TEXT.tooLong;
  if (!form.classification) out.classification = TEXT.required;
  if (!form.owner) out.owner = TEXT.required;
  if (form.clauseRef.trim().length > 40) out.clauseRef = TEXT.tooLong;
  return out;
}

export function raiseBody(form: RaiseForm): RaiseBody {
  return {
    code: form.code.trim(),
    title: form.title.trim(),
    classification: form.classification as Classification,
    source: form.source,
    ...(filled(form.clauseRef) ? { clauseRef: form.clauseRef.trim() } : {}),
    ...(form.targetCode ? { targetCode: form.targetCode } : {}),
    ...(form.auditEventId ? { auditEventId: form.auditEventId } : {}),
    ownerHandle: form.owner,
    ...(form.dueAt ? { dueAt: form.dueAt } : {}),
  };
}

export interface EditForm {
  title: string;
  classification: Classification;
  clauseRef: string;
  targetCode: string;
  owner: string;
  dueAt: string;
}

export function editFormOf(f: FindingModel): EditForm {
  return {
    title: f.title,
    classification: f.classification,
    clauseRef: f.clauseRef ?? '',
    targetCode: f.targetCode ?? '',
    owner: f.owner === 'none' ? '' : f.owner,
    dueAt: f.dueAt ?? '',
  };
}

/** The changed members of the edit form as a FindingPatch; null when nothing changed. */
export function editPatch(form: EditForm, f: FindingModel): FindingPatchBody | null {
  const out: FindingPatchBody = {};
  if (form.title.trim() !== f.title) out.title = form.title.trim();
  if (form.classification !== f.classification) out.classification = form.classification;
  if (form.clauseRef.trim() !== (f.clauseRef ?? '')) out.clauseRef = form.clauseRef.trim() || null;
  if (form.targetCode !== (f.targetCode ?? '')) out.targetCode = form.targetCode || null;
  if (form.owner && form.owner !== f.owner) out.ownerHandle = form.owner;
  if (form.dueAt !== (f.dueAt ?? '')) out.dueAt = form.dueAt || null;
  return Object.keys(out).length ? out : null;
}

export function editErrors(form: EditForm): FormErrors<keyof EditForm> {
  const out: FormErrors<keyof EditForm> = {};
  if (!filled(form.title)) out.title = TEXT.required;
  else if (form.title.trim().length > 255) out.title = TEXT.tooLong;
  if (form.clauseRef.trim().length > 40) out.clauseRef = TEXT.tooLong;
  return out;
}

/** Classifications that close only with a closed and effective corrective action (BR-08); the others close with a note. */
export const NEEDS_ACTION: ReadonlySet<Classification> = new Set(['major', 'minor']);

/** The close note a finding needs: OFI, signal and "not a finding" close with a note (C.13). */
export function closeNeedsNote(f: Pick<FindingModel, 'classification'>): boolean {
  return !NEEDS_ACTION.has(f.classification);
}

export interface ActionForm {
  findingIds: string[];
  code: string;
  title: string;
  owner: string;
  dueAt: string;
}

export function actionErrors(form: ActionForm, codes: readonly string[], create: boolean): FormErrors<keyof ActionForm> {
  const out: FormErrors<keyof ActionForm> = {};
  if (!form.findingIds.length) out.findingIds = TEXT.pickFinding;
  if (create) {
    if (!filled(form.code)) out.code = TEXT.required;
    else if (form.code.trim().length > 30 || !CODE_PATTERN.test(form.code.trim())) out.code = TEXT.badCode;
    else if (codes.includes(form.code.trim())) out.code = TEXT.codeTaken;
  }
  if (!filled(form.title)) out.title = TEXT.required;
  else if (form.title.trim().length > 255) out.title = TEXT.tooLong;
  if (!form.owner) out.owner = TEXT.required;
  return out;
}

export function actionPatch(form: ActionForm, a: ActionModel): ActionPatchBody | null {
  const out: ActionPatchBody = {};
  if (form.title.trim() !== a.title) out.title = form.title.trim();
  if (form.owner && form.owner !== a.owner) out.ownerHandle = form.owner;
  if (form.dueAt !== (a.dueAt ?? '')) out.dueAt = form.dueAt || null;
  const before = a.findings.map((f) => f.id).sort();
  const after = [...new Set(form.findingIds)].sort();
  if (before.join(',') !== after.join(',')) out.findingIds = after;
  return Object.keys(out).length ? out : null;
}

export interface AssessForm {
  status: SaStatus;
  owner: string;
  targetFixAt: string;
  note: string;
  evidence: string;
}

export function assessFormOf(row: SelfRow): AssessForm {
  return {
    status: row.status === 'not_assessed' ? 'conforming' : row.status,
    owner: row.owner && row.owner !== 'none' ? row.owner : '',
    targetFixAt: row.targetFixAt ?? '',
    note: row.note ?? '',
    evidence: row.evidence.join(', '),
  };
}

/** Evidence codes of a comma or space separated text, without repeats. */
export function evidenceCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

export function assessErrors(form: AssessForm): FormErrors<keyof AssessForm> {
  const out: FormErrors<keyof AssessForm> = {};
  if (form.status === 'gap') {
    if (!form.owner) out.owner = TEXT.gapNeedsOwner;
    if (!form.targetFixAt) out.targetFixAt = TEXT.gapNeedsDate;
  }
  if (form.note.trim().length > 2000) out.note = TEXT.tooLong;
  if (evidenceCodes(form.evidence).some((c) => c.length > 30)) out.evidence = TEXT.badCode;
  return out;
}

export function assessBody(form: AssessForm): AssessBody {
  const gap = form.status === 'gap';
  return {
    status: form.status,
    ...(form.owner ? { ownerHandle: form.owner } : {}),
    ...(form.targetFixAt && gap ? { targetFixAt: form.targetFixAt } : {}),
    ...(filled(form.note) ? { note: form.note.trim() } : {}),
    evidenceCodes: evidenceCodes(form.evidence),
  };
}

/** Findings that are still open or in progress (the req detail and the corrective action form list these). */
export const isOpen = (f: Pick<FindingModel, 'status'>): boolean => f.status !== 'closed';

/** The CA step of a status: its index in CA_STEPS (4 for the effectiveness check, 5 when finished). */
export function stepIndex(status: CaStatus): number {
  const i = CA_STEPS.findIndex((s) => s.status === status);
  if (i >= 0) return i;
  return status === 'effectiveness_verification' ? 4 : 5;
}

/** Sorts findings: open first, then by due date (none last), then by code. */
export function byUrgency(a: FindingModel, b: FindingModel): number {
  const rank = (f: FindingModel) => (f.status === 'closed' ? 1 : 0);
  return rank(a) - rank(b) || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.code.localeCompare(b.code);
}
