// The view model of the periodic access review (MILESTONE-3 M3-07, D.9) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6). Shared by Access
// reviews (`access-reviews`, the Tenant Admins) and Access review of this system (`access-review`, the Management
// System Managers and Programme Owners of a system): item kinds, decisions and states with their texts, who may do
// what, the checks of the forms, and what still holds up a sign-off or the completion.
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { Download } from '../auditor-access/shared';
import { ADMIN_ROLE_LABELS, BUSINESS_ROLE_LABELS } from '../roles';
import type { HostContext, Lang, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const ITEM_KINDS = ['membership', 'admin_role', 'linked_sign_in', 'business_role', 'auditor_access'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ORG_KINDS: readonly ItemKind[] = ['membership', 'admin_role', 'linked_sign_in'];
export const SYSTEM_KINDS: readonly ItemKind[] = ['business_role', 'auditor_access'];

export type Decision = 'keep' | 'change' | 'revoke';
export type ReviewStatus = 'open' | 'completed' | 'cancelled';
export type PartStatus = 'open' | 'signed_off';
export type FrequencyMonths = 1 | 3 | 6 | 12;
export const FREQUENCIES: readonly FrequencyMonths[] = [1, 3, 6, 12];

export const KIND_TEXT: Readonly<Record<ItemKind, TextPair>> = {
  membership: TEXT.kMembership,
  admin_role: TEXT.kAdminRole,
  linked_sign_in: TEXT.kLinkedSignIn,
  business_role: TEXT.kBusinessRole,
  auditor_access: TEXT.kAuditorAccess,
};
export const DECISION_TEXT: Readonly<Record<Decision, TextPair>> = { keep: TEXT.dKeep, change: TEXT.dChange, revoke: TEXT.dRevoke };
export const DECISION_TONE: Readonly<Record<Decision, Tone>> = { keep: 'ok', change: 'warn', revoke: 'bad' };
export const STATUS_TEXT: Readonly<Record<ReviewStatus, TextPair>> = { open: TEXT.stOpen, completed: TEXT.stCompleted, cancelled: TEXT.stCancelled };
export const STATUS_TONE: Readonly<Record<ReviewStatus, Tone>> = { open: 'warn', completed: 'ok', cancelled: 'mute' };
export const PART_STATUS_TEXT: Readonly<Record<PartStatus, TextPair>> = { open: TEXT.psOpen, signed_off: TEXT.psSignedOff };
export const PART_STATUS_TONE: Readonly<Record<PartStatus, Tone>> = { open: 'warn', signed_off: 'ok' };
export const FREQUENCY_TEXT: Readonly<Record<FrequencyMonths, TextPair>> = { 1: TEXT.f1, 3: TEXT.f3, 6: TEXT.f6, 12: TEXT.f12 };

export interface PersonRef {
  handle: string;
  displayName: string;
}

export interface Settings {
  frequencyMonths: FrequencyMonths;
  nextDueOn: string | null;
  daysToComplete: number;
  etag: string;
}

export interface Progress {
  items: number;
  decided: number;
  revocations: number;
  applied: number;
  parts: number;
  signedOff: number;
}

export interface ReviewRow {
  id: string;
  reviewNo: string;
  status: ReviewStatus;
  openedOn: string;
  dueOn: string;
  openedBy: PersonRef | null;
  completedAt: string | null;
  completedBy: PersonRef | null;
  cancelReason: string | null;
  progress: Progress;
}

export interface ItemRow {
  id: string;
  kind: ItemKind;
  subject: PersonRef;
  ms: MsId | null;
  role: string | null;
  grantedBy: PersonRef | null;
  grantedAt: string | null;
  /** Who asked for a business role grant, and who approved it under the four-eyes flow (D.9). */
  requestedBy: PersonRef | null;
  approvedBy: PersonRef | null;
  validUntil: string | null;
  lastSignInAt: string | null;
  decision: Decision | null;
  decisionNote: string | null;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedBy: PersonRef | null;
  appliedAction: string | null;
  appliedNote: string | null;
  notAppliedReason: string | null;
  ownAccess: boolean;
  pendingApproval: boolean;
  needsSecondReviewer: boolean;
}

export interface PartRow {
  id: string;
  reviewId: string;
  reviewNo: string;
  reviewStatus: ReviewStatus;
  ms: MsId | null;
  status: PartStatus;
  dueOn: string;
  items: number;
  decided: number;
  needsSecondReviewer: number;
  /** An open part nobody may decide now (no active Management System Manager or Programme Owner). */
  noReviewer: boolean;
  signedOffBy: PersonRef | null;
  signedOffAt: string | null;
  evidenceId: string | null;
  evidenceCode: string | null;
  evidenceFiledAt: string | null;
}

export interface PartDetail extends PartRow {
  rows: ItemRow[];
  suggestedEvidence: { id: string; code: string } | null;
}

export interface WarningRow {
  rule: string;
  messages: { en: string; id: string };
}

export interface ReviewDetail extends ReviewRow {
  organisationPart: PartDetail;
  parts: PartRow[];
  pendingApplications: ItemRow[];
  warnings: WarningRow[];
}

export interface SettingsBody {
  frequencyMonths: FrequencyMonths;
  nextDueOn: string;
  daysToComplete: number;
}

export interface DecideBody {
  decision: Decision;
  note?: string;
}

export type ApplyBody = { action: 'apply' } | { action: 'mark_applied'; note?: string } | { action: 'not_applied'; reason: string };

/** What a command answered: the server's message and warnings, the systems it changed and its data. */
export interface Outcome {
  message: TextPair | null;
  warnings: WarningRow[];
  changed: string[];
  data: unknown;
}

/** An evidence item of a system the sign-off may name. */
export interface EvidenceOption {
  id: string;
  code: string;
  title: string;
}

export interface AccessReviewsAdapter {
  readonly sample: boolean;
  settings(): Promise<Result<Settings>>;
  putSettings(body: SettingsBody, etag: string): Promise<Result<Settings>>;
  list(): Promise<Result<ReviewRow[]>>;
  create(idempotencyKey: string): Promise<Result<Outcome>>;
  get(id: string): Promise<Result<ReviewDetail>>;
  decide(id: string, itemId: string, body: DecideBody): Promise<Result<Outcome>>;
  apply(id: string, itemId: string, body: ApplyBody): Promise<Result<Outcome>>;
  complete(id: string): Promise<Result<Outcome>>;
  cancel(id: string, reason: string): Promise<Result<Outcome>>;
  report(review: Pick<ReviewRow, 'id' | 'reviewNo'>): Promise<Result<Download>>;
  msList(ms: MsId): Promise<Result<PartRow[]>>;
  msGet(ms: MsId, id: string): Promise<Result<PartDetail>>;
  msDecide(ms: MsId, id: string, itemId: string, body: DecideBody): Promise<Result<Outcome>>;
  msApply(ms: MsId, id: string, itemId: string, body: ApplyBody): Promise<Result<Outcome>>;
  signOff(ms: MsId, id: string, evidenceId: string | null): Promise<Result<Outcome>>;
  /** The evidence items of a system for the sign-off picker. */
  evidence(ms: MsId): EvidenceOption[];
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

export function asApiResult<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }));
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6 and J.2: `access_review.manage` [TA], `access_review.decide` [MM, PO]; applying needs
// `user.manage` [TA], or `auditor_access.grant` [MM] for a guest grant)
// ---------------------------------------------------------------------------------------------------------------

export const mayManage = (ctx: Pick<HostContext, 'orgCan'>): boolean => ctx.orgCan('access_review.manage');
export const mayApplyOrg = (ctx: Pick<HostContext, 'orgCan'>): boolean => ctx.orgCan('user.manage');
export const mayDecide = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'access_review.decide');
export const mayRevokeGuest = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'auditor_access.grant');

// ---------------------------------------------------------------------------------------------------------------
// Texts of rows
// ---------------------------------------------------------------------------------------------------------------

/** What an item reviews, in words: "Domain Owner", "Tenant Admin", "Sign in with keycloak", "Active membership". */
export function accessText(item: Pick<ItemRow, 'kind' | 'role'>, li: (t: TextPair) => string): string {
  const role = item.role ?? '';
  switch (item.kind) {
    case 'business_role':
    case 'auditor_access':
      return role in BUSINESS_ROLE_LABELS ? li(BUSINESS_ROLE_LABELS[role as keyof typeof BUSINESS_ROLE_LABELS]) : role;
    case 'admin_role':
      return role in ADMIN_ROLE_LABELS ? li(ADMIN_ROLE_LABELS[role as keyof typeof ADMIN_ROLE_LABELS]) : role;
    case 'membership':
      return li(role === 'invited' ? TEXT.mInvited : TEXT.mActive);
    case 'linked_sign_in':
      return role;
    default:
      return role;
  }
}

/** How a decision was applied, in words. */
export function appliedText(item: Pick<ItemRow, 'appliedAction' | 'appliedAt' | 'notAppliedReason'>, li: (t: TextPair) => string): string | null {
  if (item.notAppliedReason !== null) return li(TEXT.aNotApplied);
  switch (item.appliedAction) {
    case null:
      return null;
    case 'already_removed':
      return li(TEXT.aAlreadyRemoved);
    case 'marked_applied':
      return li(TEXT.aMarked);
    default:
      return li(TEXT.aApplied);
  }
}

/** True when a decided revocation or change still waits to be applied or explained. */
export const waitsForApplication = (item: Pick<ItemRow, 'decision' | 'appliedAt' | 'notAppliedReason'>): boolean =>
  (item.decision === 'revoke' || item.decision === 'change') && item.appliedAt === null && item.notAppliedReason === null;

/** The handle of the signed-in person (API: `me`; sample: the persona's person). */
export function myHandle(ctx: Pick<HostContext, 'me' | 'person'>): string | null {
  return ctx.me?.user?.handle ?? ctx.person?.handle ?? null;
}

/** A date as `13 Oct 2026` in the interface language; `-` without one. */
export function formatDay(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '-';
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return '-';
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

// ---------------------------------------------------------------------------------------------------------------
// What holds up a sign-off or the completion
// ---------------------------------------------------------------------------------------------------------------

/** Why a system part cannot be signed off yet; null when it can. */
export function signOffBlock(part: Pick<PartDetail, 'status' | 'reviewStatus' | 'rows'>): TextPair | null {
  if (part.reviewStatus !== 'open') return TEXT.blockNotOpen;
  if (part.status === 'signed_off') return TEXT.blockSignedOff;
  if (part.rows.some((r) => r.decision === null && !r.needsSecondReviewer)) return TEXT.blockUndecided;
  return null;
}

/** The system parts of a review that nobody may decide now: a Tenant Admin assigns a reviewer or cancels the review. */
export const noReviewerParts = (review: Pick<ReviewDetail, 'status' | 'parts'>): PartRow[] =>
  review.status === 'open' ? review.parts.filter((p) => p.status !== 'signed_off' && p.noReviewer) : [];

/** What still holds up the completion of a review, as lines; empty when it can complete. */
export function completionBlocks(review: Pick<ReviewDetail, 'status' | 'parts' | 'organisationPart' | 'pendingApplications'>, li: (t: TextPair) => string, fill: (t: TextPair, v: Record<string, string | number>) => string): string[] {
  if (review.status !== 'open') return [li(TEXT.blockNotOpen)];
  const out: string[] = [];
  const open = review.parts.filter((p) => p.status !== 'signed_off' && !p.noReviewer).map((p) => p.ms ?? '');
  if (open.length) out.push(fill(TEXT.waitSystems, { systems: open.map((s) => s.toUpperCase()).join(', ') }));
  for (const part of noReviewerParts(review)) out.push(fill(TEXT.waitNoReviewer, { system: (part.ms ?? '').toUpperCase() }));
  const undecided = review.organisationPart.rows.filter((r) => r.decision === null && !r.needsSecondReviewer).length;
  if (undecided) out.push(fill(TEXT.waitOrgItems, { n: undecided }));
  if (review.pendingApplications.length) out.push(fill(TEXT.waitApplications, { n: review.pendingApplications.length }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface SettingsForm {
  frequencyMonths: string;
  nextDueOn: string;
  daysToComplete: string;
}

export function settingsErrors(form: SettingsForm, today: string): Partial<Record<keyof SettingsForm, TextPair>> {
  const out: Partial<Record<keyof SettingsForm, TextPair>> = {};
  if (!FREQUENCIES.includes(Number(form.frequencyMonths) as FrequencyMonths)) out.frequencyMonths = TEXT.badFrequency;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.nextDueOn) || form.nextDueOn < today) out.nextDueOn = TEXT.badNextDue;
  const days = Number(form.daysToComplete);
  if (!/^\d+$/.test(form.daysToComplete.trim()) || days < 1 || days > 60) out.daysToComplete = TEXT.badDays;
  return out;
}

export const settingsBody = (form: SettingsForm): SettingsBody => ({
  frequencyMonths: Number(form.frequencyMonths) as FrequencyMonths,
  nextDueOn: form.nextDueOn,
  daysToComplete: Number(form.daysToComplete),
});

export interface DecisionForm {
  decision: Decision | '';
  note: string;
}

export function decisionErrors(form: DecisionForm): Partial<Record<keyof DecisionForm, TextPair>> {
  const out: Partial<Record<keyof DecisionForm, TextPair>> = {};
  if (!form.decision) out.decision = TEXT.badDecision;
  if (form.decision === 'change' && !form.note.trim()) out.note = TEXT.badChangeNote;
  if (form.note.trim().length > 500) out.note = TEXT.tooLong500;
  return out;
}

export const decisionBody = (form: DecisionForm): DecideBody => ({
  decision: form.decision as Decision,
  ...(form.note.trim() ? { note: form.note.trim() } : {}),
});

/** A reason or note of up to 500 characters; required unless `optional`. */
export function noteError(text: string, optional = false): TextPair | null {
  if (!text.trim()) return optional ? null : TEXT.badReason;
  if (text.trim().length > 500) return TEXT.tooLong500;
  return null;
}
