// The view model of Retention and disposal (MILESTONE-3 M3-06, D.8) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6). Record classes, review states and
// file actions with their texts; who may do what; the forms (rule, decision, hold, release, reject) with their checks.
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { Download } from '../auditor-access/shared';
import type { HostContext, Lang, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const RECORD_CLASSES = [
  'document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record',
] as const;
export type RecordClass = (typeof RECORD_CLASSES)[number];

export const CLASS_TEXT: Readonly<Record<RecordClass, TextPair>> = {
  document_version: TEXT.cDocumentVersion,
  evidence_file: TEXT.cEvidenceFile,
  evidence_pack: TEXT.cEvidencePack,
  audit_event: TEXT.cAuditEvent,
  finding: TEXT.cFinding,
  corrective_action: TEXT.cCorrectiveAction,
  management_review: TEXT.cManagementReview,
  competence_record: TEXT.cCompetenceRecord,
};

/** When the retention period of a class starts (the Rules tab explains it next to each class). */
export const CLASS_START_TEXT: Readonly<Record<RecordClass, TextPair>> = {
  document_version: TEXT.sDocumentVersion,
  evidence_file: TEXT.sEvidenceFile,
  evidence_pack: TEXT.sEvidencePack,
  audit_event: TEXT.sAuditEvent,
  finding: TEXT.sFinding,
  corrective_action: TEXT.sCorrectiveAction,
  management_review: TEXT.sManagementReview,
  competence_record: TEXT.sCompetenceRecord,
};

export type ReviewStatus = 'open' | 'kept' | 'extended' | 'awaiting_approval' | 'disposed';
export type Decision = 'keep' | 'extend' | 'dispose';
export type FileAction = 'vault_content_deleted' | 'owner_asked' | 'none';

export const STATUS_TEXT: Readonly<Record<ReviewStatus, TextPair>> = {
  open: TEXT.stOpen, kept: TEXT.stKept, extended: TEXT.stExtended, awaiting_approval: TEXT.stAwaiting, disposed: TEXT.stDisposed,
};
export const STATUS_TONE: Readonly<Record<ReviewStatus, Tone>> = { open: 'warn', kept: 'info', extended: 'info', awaiting_approval: 'acc', disposed: 'mute' };
export const FILE_ACTION_TEXT: Readonly<Record<FileAction, TextPair>> = {
  vault_content_deleted: TEXT.faVault, owner_asked: TEXT.faOwner, none: TEXT.faNone,
};

/** The document types the sample build knows (the `doc_type` lookup of every pack). */
export const SAMPLE_DOC_TYPES: readonly { code: string; label: TextPair }[] = [
  { code: 'policy', label: ['Policy', 'Kebijakan'] },
  { code: 'standard', label: ['Standard', 'Standar'] },
  { code: 'procedure', label: ['Procedure', 'Prosedur'] },
  { code: 'plan', label: ['Plan', 'Rencana'] },
  { code: 'register', label: ['Register', 'Register'] },
  { code: 'record', label: ['Record', 'Rekaman'] },
  { code: 'form', label: ['Form', 'Formulir'] },
];

export const DEFAULT_MONTHS = 36;

export interface PersonRef {
  handle: string;
  displayName: string;
}

/** The period in force for a class (and document type) of the system (`retention.rules.list`). */
export interface RuleModel {
  recordClass: RecordClass;
  docType: string | null;
  docTypeLabel: TextPair | null;
  retainMonths: number;
  source: 'default' | 'set';
  basis: string | null;
}

/** A disposal review (`retention.reviews.list`). */
export interface ReviewModel {
  id: string;
  recordClass: RecordClass;
  itemId: string;
  itemCode: string | null;
  itemTitle: string | null;
  retentionEndsOn: string;
  status: ReviewStatus;
  decision: Decision | null;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  reason: string | null;
  keepUntil: string | null;
  approvedBy: PersonRef | null;
  approvedAt: string | null;
  rejectedNote: string | null;
  disposedAt: string | null;
  fileAction: FileAction | null;
  fileRemovedAt: string | null;
  onHold: boolean;
}

/** A decided review in the disposal register, with the period of its class. */
export type RegisterModel = Omit<ReviewModel, 'onHold'> & { retainMonths: number };

/** A legal hold (`retention.holds.list`). */
export interface HoldModel {
  id: string;
  recordClass: RecordClass;
  itemId: string;
  itemCode: string | null;
  reason: string;
  setBy: PersonRef | null;
  setAt: string;
  releasedBy: PersonRef | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface ReviewQuery {
  status?: ReviewStatus;
  recordClass?: RecordClass;
  code?: string;
  page: number;
  pageSize: number;
}

export interface PageOf<T> {
  items: T[];
  total: number;
}

export interface RuleBody {
  docType?: string;
  retainMonths: number | null;
  basis: string;
}

export interface DecideBody {
  ids: string[];
  decision: Decision;
  reason: string;
  keepUntil?: string;
  extendMonths?: number;
}

export interface HoldBody {
  recordClass: RecordClass;
  itemId?: string;
  itemCode?: string;
  reason: string;
}

/** What a command answered: the server's message, when it sent one. */
export interface Outcome {
  message: TextPair | null;
}

export interface RetentionAdapter {
  readonly sample: boolean;
  rules(ms: MsId): Promise<Result<RuleModel[]>>;
  putRule(ms: MsId, recordClass: RecordClass, body: RuleBody): Promise<Result<Outcome>>;
  reviews(ms: MsId, query: ReviewQuery): Promise<Result<PageOf<ReviewModel>>>;
  decide(ms: MsId, body: DecideBody): Promise<Result<Outcome>>;
  approve(ms: MsId, review: ReviewModel): Promise<Result<Outcome>>;
  reject(ms: MsId, review: ReviewModel, note: string): Promise<Result<Outcome>>;
  fileRemoved(ms: MsId, review: RegisterModel): Promise<Result<Outcome>>;
  register(ms: MsId, page: number, pageSize: number): Promise<Result<PageOf<RegisterModel>>>;
  exportCsv(ms: MsId): Promise<Result<Download>>;
  holds(ms: MsId): Promise<Result<HoldModel[]>>;
  createHold(ms: MsId, body: HoldBody, idempotencyKey: string): Promise<Result<Outcome>>;
  releaseHold(ms: MsId, hold: HoldModel, reason: string): Promise<Result<Outcome>>;
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

export function asApiResult<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }));
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6: `retention.manage` [MM], `retention.approve` [MM, PO])
// ---------------------------------------------------------------------------------------------------------------

export const mayManage = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'retention.manage');
export const mayApprove = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'retention.approve');
export const mayRead = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => mayManage(ctx, ms) || mayApprove(ctx, ms);

/** The handle of the signed-in person (API: `me`; sample: the persona's person). */
export function myHandle(ctx: Pick<HostContext, 'me' | 'person'>): string | null {
  return ctx.me?.user?.handle ?? ctx.person?.handle ?? null;
}

/** True when the signed-in person proposed the disposal (SOD-SELF-APPROVE: another person must approve). */
export function proposedByMe(ctx: Pick<HostContext, 'me' | 'person'>, review: Pick<ReviewModel, 'decidedBy'>): boolean {
  const me = myHandle(ctx);
  return Boolean(me) && review.decidedBy?.handle === me;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------

/** A date as `15 Sep 2026` (English) or `15 Sep 2026` in Indonesian month names; `-` without one. */
export function formatDay(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '-';
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return '-';
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

/** `iso` plus whole months (the day kept or moved back to the end of a shorter month), as the server computes it. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface RuleForm {
  months: string;
  basis: string;
}

export function ruleErrors(form: RuleForm, reset: boolean): Partial<Record<keyof RuleForm, TextPair>> {
  const out: Partial<Record<keyof RuleForm, TextPair>> = {};
  if (!reset && (!/^\d+$/.test(form.months.trim()) || Number(form.months) < 1 || Number(form.months) > 1200)) out.months = TEXT.badMonths;
  if (!form.basis.trim()) out.basis = TEXT.badBasis;
  else if (form.basis.trim().length > 500) out.basis = TEXT.tooLong500;
  return out;
}

export function ruleBody(rule: Pick<RuleModel, 'recordClass' | 'docType'>, form: RuleForm, reset: boolean): RuleBody {
  return {
    ...(rule.recordClass === 'document_version' && rule.docType ? { docType: rule.docType } : {}),
    retainMonths: reset ? null : Number(form.months),
    basis: form.basis.trim(),
  };
}

export interface DecisionForm {
  decision: Decision | '';
  keepUntil: string;
  months: string;
  reason: string;
}

export const emptyDecision = (): DecisionForm => ({ decision: '', keepUntil: '', months: '12', reason: '' });

export function decisionErrors(form: DecisionForm, today: string): Partial<Record<keyof DecisionForm, TextPair>> {
  const out: Partial<Record<keyof DecisionForm, TextPair>> = {};
  if (!form.decision) out.decision = TEXT.badDecision;
  if (form.decision === 'keep' && (!/^\d{4}-\d{2}-\d{2}$/.test(form.keepUntil) || form.keepUntil <= today)) out.keepUntil = TEXT.badKeepUntil;
  if (form.decision === 'extend' && (!/^\d+$/.test(form.months.trim()) || Number(form.months) < 1 || Number(form.months) > 1200)) out.months = TEXT.badMonths;
  if (!form.reason.trim()) out.reason = TEXT.badReason;
  else if (form.reason.trim().length > 1000) out.reason = TEXT.tooLong1000;
  return out;
}

export function decisionBody(ids: string[], form: DecisionForm): DecideBody {
  const decision = form.decision as Decision;
  return {
    ids,
    decision,
    reason: form.reason.trim(),
    ...(decision === 'keep' ? { keepUntil: form.keepUntil } : {}),
    ...(decision === 'extend' ? { extendMonths: Number(form.months) } : {}),
  };
}

export interface HoldForm {
  recordClass: RecordClass | '';
  code: string;
  reason: string;
}

export function holdErrors(form: HoldForm, byId: boolean): Partial<Record<keyof HoldForm, TextPair>> {
  const out: Partial<Record<keyof HoldForm, TextPair>> = {};
  if (!byId && !form.recordClass) out.recordClass = TEXT.badClass;
  if (!byId && !form.code.trim()) out.code = TEXT.badCode;
  else if (!byId && form.code.trim().length > 60) out.code = TEXT.tooLong60;
  if (!form.reason.trim()) out.reason = TEXT.badReason;
  else if (form.reason.trim().length > 500) out.reason = TEXT.tooLong500;
  return out;
}

/** A note or reason of up to `max` characters, required. */
export function noteError(text: string, max: number): TextPair | null {
  if (!text.trim()) return TEXT.badReason;
  if (text.trim().length > max) return max === 500 ? TEXT.tooLong500 : TEXT.tooLong1000;
  return null;
}

/** The code shown for an item (its title when it has no code). */
export const itemLabel = (r: Pick<ReviewModel, 'itemCode' | 'itemTitle' | 'itemId'>): string => r.itemCode ?? r.itemTitle ?? r.itemId.slice(0, 8);

/** The rule in force for an item of a class (and document type). */
export function ruleFor(rules: readonly RuleModel[], recordClass: RecordClass, docType?: string | null): RuleModel | null {
  return rules.find((r) => r.recordClass === recordClass && (recordClass !== 'document_version' || r.docType === docType)) ?? null;
}
