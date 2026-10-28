// The view model of the Management review screen (MILESTONE-2 M2-14) and the interface both adapters implement (api.ts
// in API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6).
//
// In plain words: in a management review top management looks at the inputs the standard lists (status of earlier
// actions, changes, performance, audit results, risks, improvement) and decides what to change. A review is planned,
// held (the meeting took place) and closed with its decisions; it closes only when every mandatory input of every
// linked system has content (BR-13) and the decisions are recorded (BR-14).
import type { MsId } from '../../data/types';
import type { Outcome, Result } from '../findings/shared';
import { filled } from '../findings/shared';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

export const REVIEW_STATUSES = ['planned', 'held', 'closed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_TEXT: Readonly<Record<ReviewStatus, TextPair>> = { planned: TEXT.stPlanned, held: TEXT.stHeld, closed: TEXT.stClosed };
export const REVIEW_STATUS_TONE: Readonly<Record<ReviewStatus, Tone>> = { planned: 'info', held: 'warn', closed: 'ok' };

export interface ReviewInput {
  defCode: string;
  title: string;
  mandatory: boolean;
  ms: MsId;
  complete: boolean;
  content: string | null;
}

export interface ReviewModel {
  id: string;
  code: string;
  title: string;
  owner: string;
  plannedAt: string | null;
  heldAt: string | null;
  status: ReviewStatus;
  decisionsRecorded: boolean;
  decisionsText: string | null;
  linkedMs: MsId[];
  inputs: ReviewInput[];
  etag: string | null;
}

export interface ReviewCreateBody {
  code: string;
  title: string;
  plannedAt: string;
  ownerHandle: string;
  linkedMs: MsId[];
}

export interface ReviewPatchBody {
  title?: string;
  plannedAt?: string;
  ownerHandle?: string;
  linkedMs?: MsId[];
}

export type ReviewMove = { to: 'held'; heldAt?: string } | { to: 'closed'; decisionsText?: string };

export interface ReviewAdapter {
  readonly sample: boolean;
  list(ms: MsId): Promise<Result<ReviewModel[]>>;
  create(ms: MsId, body: ReviewCreateBody, idempotencyKey: string): Promise<Result<Outcome>>;
  update(ms: MsId, review: ReviewModel, patch: ReviewPatchBody): Promise<Result<Outcome>>;
  putInput(ms: MsId, review: ReviewModel, defCode: string, content: string): Promise<Result<Outcome>>;
  move(ms: MsId, review: ReviewModel, body: ReviewMove): Promise<Result<Outcome>>;
}

/** MS Managers and Programme Owners plan, hold and close reviews (`management_review.manage`). */
export const mayManage = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'management_review.manage');

/** Complete mandatory inputs of a review, of every linked system or of one. */
export function completeness(review: Pick<ReviewModel, 'inputs'>, ms?: MsId): { done: number; total: number } {
  const mandatory = review.inputs.filter((i) => i.mandatory && (!ms || i.ms === ms));
  return { done: mandatory.filter((i) => i.complete).length, total: mandatory.length };
}

/** The inputs grouped by system, the path system first. */
export function inputsBySystem(review: Pick<ReviewModel, 'inputs' | 'linkedMs'>, first: MsId): { ms: MsId; inputs: ReviewInput[] }[] {
  const order = [first, ...review.linkedMs.filter((m) => m !== first)];
  for (const i of review.inputs) if (!order.includes(i.ms)) order.push(i.ms);
  return order.map((ms) => ({ ms, inputs: review.inputs.filter((i) => i.ms === ms) })).filter((g) => g.inputs.length);
}

export interface ReviewForm {
  code: string;
  title: string;
  plannedAt: string;
  owner: string;
  linked: MsId[];
}

export type FormErrors<K extends string> = Partial<Record<K, TextPair>>;

const CODE_PATTERN = /^\S(?:.*\S)?$/;

export function reviewErrors(form: ReviewForm, codes: readonly string[], create: boolean): FormErrors<keyof ReviewForm> {
  const out: FormErrors<keyof ReviewForm> = {};
  if (create) {
    if (!filled(form.code)) out.code = TEXT.required;
    else if (form.code.trim().length > 30 || !CODE_PATTERN.test(form.code.trim())) out.code = TEXT.badCode;
    else if (codes.includes(form.code.trim())) out.code = TEXT.codeTaken;
  }
  if (!filled(form.title)) out.title = TEXT.required;
  else if (form.title.trim().length > 255) out.title = TEXT.tooLong;
  if (!form.plannedAt) out.plannedAt = TEXT.required;
  if (!form.owner) out.owner = TEXT.required;
  return out;
}

/** The body of a new review: the path system first, as primary (D.2). */
export function createBody(form: ReviewForm, ms: MsId): ReviewCreateBody {
  return { code: form.code.trim(), title: form.title.trim(), plannedAt: form.plannedAt, ownerHandle: form.owner, linkedMs: [ms, ...form.linked.filter((m) => m !== ms)] };
}

export function formOf(review: ReviewModel): ReviewForm {
  return { code: review.code, title: review.title, plannedAt: review.plannedAt ?? '', owner: review.owner === 'none' ? '' : review.owner, linked: [...review.linkedMs] };
}

/** The changed members of the edit form as a ManagementReviewPatch; null when nothing changed. */
export function reviewPatch(form: ReviewForm, review: ReviewModel, ms: MsId): ReviewPatchBody | null {
  const out: ReviewPatchBody = {};
  if (form.title.trim() !== review.title) out.title = form.title.trim();
  if (form.plannedAt && form.plannedAt !== (review.plannedAt ?? '')) out.plannedAt = form.plannedAt;
  if (form.owner && form.owner !== review.owner) out.ownerHandle = form.owner;
  const linked = [ms, ...form.linked.filter((m) => m !== ms)];
  if ([...linked].sort().join(',') !== [...review.linkedMs].sort().join(',')) out.linkedMs = linked;
  return Object.keys(out).length ? out : null;
}
