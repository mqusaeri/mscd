// The view model of the certification timeline forms (MILESTONE-2 M2-15) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6).
//
// In plain words: a certification cycle covers about three years. It starts with the Stage 1 audit (is the system
// ready?) and the Stage 2 audit (does it work?), after which the certification body issues the certificate; a
// surveillance audit follows each year, and the recertification audit renews the certificate. The body can suspend
// or withdraw a certificate. Preparation tasks get the team ready for the next audit; cycle items are what the
// auditor checks across the cycle (internal audit held, management review held, and so on).
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { AuditEvent, ControllerData, MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

// ---------------------------------------------------------------------------------------------------------------
// Results of adapter calls
// ---------------------------------------------------------------------------------------------------------------

/** The answer of an adapter call: its data, or the api's error with its message pair and field errors. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A warn-and-allow rule result of a write (AUD-INDEP, BR-41). */
export interface Warn {
  rule: string;
  message: TextPair;
}

/** What a write answered: the systems to load again, warnings, the server's message, the record's new ETag, a count. */
export interface Outcome {
  changed: MsId[];
  warnings: Warn[];
  message?: TextPair;
  etag?: string;
  id?: string;
  count?: number;
}

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const refusal = (status: number, message: TextPair, rule?: string): { ok: false; error: ApiError } => ({
  ok: false,
  error: { status, message: [message[0], message[1]], ...(rule ? { rule } : {}) },
});

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** The ApiResult shape `useMutation` keeps (status of the error, or 200). */
export function asApiResult<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }));
}

// ---------------------------------------------------------------------------------------------------------------
// Event types, outcomes and statuses
// ---------------------------------------------------------------------------------------------------------------

export const EVENT_TYPES = ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** Types "Add audit event" offers: the certification body's audits (internal audits have their own screen, M2-14). */
export const ADDABLE_TYPES: readonly EventType[] = ['stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special'];
/** Certification audits: they get audit activities from the pack's templates. */
export const CERTIFICATION_AUDITS: readonly EventType[] = ['stage1', 'stage2', 'surveillance', 'recertification'];
/** Audits whose recommended result lets the certificate be recorded (D.4). */
export const CERTIFYING_AUDITS: readonly EventType[] = ['stage2', 'recertification'];

export const EVENT_TYPE_TEXT: Readonly<Record<EventType, TextPair>> = {
  stage1: TEXT.tStage1,
  stage2: TEXT.tStage2,
  surveillance: TEXT.tSurveillance,
  recertification: TEXT.tRecertification,
  transition: TEXT.tTransition,
  special: TEXT.tSpecial,
  internal_audit: TEXT.tInternal,
};

/** Names a new event of a type starts with ([English name, Indonesian name, short label]). */
export const EVENT_DEFAULTS: Readonly<Record<EventType, readonly [string, string, string]>> = {
  stage1: ['Stage 1 audit', 'Audit tahap 1', 'Stage 1'],
  stage2: ['Stage 2 audit', 'Audit tahap 2', 'Stage 2'],
  surveillance: ['Surveillance audit', 'Audit surveilans', 'Surveillance'],
  recertification: ['Recertification audit', 'Audit resertifikasi', 'Recertification'],
  transition: ['Transition audit', 'Audit transisi', 'Transition'],
  special: ['Special audit', 'Audit khusus', 'Special audit'],
  internal_audit: ['Internal audit', 'Audit internal', 'Internal audit'],
};

export const OUTCOMES = ['recommended', 'recommended_with_conditions', 'not_recommended'] as const;
export type AuditOutcome = (typeof OUTCOMES)[number];
export const OUTCOME_TEXT: Readonly<Record<AuditOutcome, TextPair>> = {
  recommended: TEXT.oRecommended,
  recommended_with_conditions: TEXT.oConditions,
  not_recommended: TEXT.oNotRecommended,
};
export const OUTCOME_TONE: Readonly<Record<AuditOutcome, Tone>> = { recommended: 'ok', recommended_with_conditions: 'warn', not_recommended: 'bad' };
export const isRecommended = (o: AuditOutcome | null | undefined): boolean => o === 'recommended' || o === 'recommended_with_conditions';

export const CYCLE_STATUSES = ['planned', 'active', 'certified', 'suspended', 'withdrawn', 'expired', 'closed'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
export const CYCLE_STATUS_TEXT: Readonly<Record<CycleStatus, TextPair>> = {
  planned: TEXT.cyPlanned, active: TEXT.cyActive, certified: TEXT.cyCertified, suspended: TEXT.cySuspended,
  withdrawn: TEXT.cyWithdrawn, expired: TEXT.cyExpired, closed: TEXT.cyClosed,
};
export const CYCLE_STATUS_TONE: Readonly<Record<CycleStatus, Tone>> = {
  planned: 'info', active: 'acc', certified: 'ok', suspended: 'warn', withdrawn: 'bad', expired: 'bad', closed: 'mute',
};

export const ACTIVITY_STATUSES = ['planned', 'done', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_STATUS_TEXT: Readonly<Record<ActivityStatus, TextPair>> = { planned: TEXT.acPlanned, done: TEXT.acDone, cancelled: TEXT.acCancelled };
export const ACTIVITY_STATUS_TONE: Readonly<Record<ActivityStatus, Tone>> = { planned: 'info', done: 'ok', cancelled: 'mute' };

/** The manual moves of a cycle (J.8, `ms.cycles.transition`). */
export const CYCLE_MOVES = ['suspended', 'certified', 'withdrawn', 'closed'] as const;
export type CycleMove = (typeof CYCLE_MOVES)[number];

/**
 * The moves a cycle in a status offers (J.8, D.1, the `ms.cycles.transition` rows of the shared machine): suspend a
 * certificate, reinstate or withdraw a suspended one, close an active cycle. A certified cycle is suspended before it
 * can be withdrawn; the server refuses any other move with 409, and the sample adapter follows this same function.
 */
export function movesOf(status: CycleStatus): CycleMove[] {
  if (status === 'certified') return ['suspended'];
  if (status === 'suspended') return ['certified', 'withdrawn'];
  if (status === 'active') return ['closed'];
  return [];
}

export const MOVE_TEXT: Readonly<Record<CycleMove, { action: TextPair; title: TextPair; sub: TextPair; tone: 'acc' | 'bad' }>> = {
  suspended: { action: TEXT.suspend, title: TEXT.suspendTitle, sub: TEXT.suspendSub, tone: 'bad' },
  certified: { action: TEXT.reinstate, title: TEXT.reinstateTitle, sub: TEXT.reinstateSub, tone: 'acc' },
  withdrawn: { action: TEXT.withdraw, title: TEXT.withdrawTitle, sub: TEXT.withdrawSub, tone: 'bad' },
  closed: { action: TEXT.closeCycle, title: TEXT.closeTitle, sub: TEXT.closeSub, tone: 'bad' },
};

// ---------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------

/** An audit event of a cycle, as `ms.cycles.list` gives it. */
export interface CycleEvent {
  id: string;
  eventType: EventType;
  shortLabel: string;
  scheduledAt: string;
  outcome: AuditOutcome | null;
}

/** A certification cycle with its certificate (`ms.cycles.list`, D.1). */
export interface CycleModel {
  id: string;
  status: CycleStatus;
  cycleStart: string;
  cycleEnd: string;
  certificateNo: string | null;
  certifiedAt: string | null;
  certificateExpiresAt: string | null;
  certificationBody: string | null;
  certifiedScope: string | null;
  events: CycleEvent[];
  items: { total: number; done: number };
  /** Sent as `If-Match` on a manual move (R-18). */
  etag: string | null;
}

/** A row of the timeline with the event behind it: its api id, type, result and cycle. */
export interface EventModel extends CycleEvent {
  ms: MsId;
  cycleId: string | null;
  /** Position of the row in the system's `EVENTS` (the sample adapter changes it there). */
  index: number;
}

/** What "Edit" and "Record result" start from. */
export interface EventDetail {
  eventType: EventType;
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: number | null;
  leadAuditor: string | null;
  expectedFocus: string | null;
  /** Null when the api does not say (only the next event carries it). */
  prepWindowDays: number | null;
  outcome: AuditOutcome | null;
  outcomeSummary: string | null;
}

export interface ActivityModel {
  id: string;
  /** The code shown: the template code, else the title. */
  code: string;
  templateCode: string | null;
  title: string;
  clauseRef: string | null;
  keyQuestions: string | null;
  evidenceToRequest: string | null;
  auditee: string | null;
  auditor: string | null;
  targetCode: string | null;
  scheduledAt: string | null;
  status: ActivityStatus;
  note: string | null;
}

/** A preparation task of the next audit or an item of the certification cycle, as the timeline row shows it. */
export interface ItemModel {
  kind: 'prep' | 'cycle';
  ms: MsId;
  /** The key of the row: the task title, or the requirement code of a cycle item. */
  code: string;
  title: string;
  owner: string;
  due: string;
  status: 'done' | 'progress' | 'open';
  /** Date of the audit a preparation task belongs to (BR-43); null for cycle items. */
  auditDate: string | null;
}

export interface EventCreateBody {
  eventType: EventType;
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays?: number;
  leadAuditorName?: string;
  expectedFocus?: string;
  prepWindowDays?: number;
}

export interface EventPatchBody {
  eventType?: EventType;
  nameEn?: string;
  nameId?: string;
  shortLabel?: string;
  scheduledAt?: string;
  auditDays?: number | null;
  leadAuditorName?: string | null;
  expectedFocus?: string | null;
  prepWindowDays?: number;
  outcome?: AuditOutcome | null;
  outcomeSummary?: string | null;
}

export interface CertificateBody {
  certificateNo: string;
  issuedAt: string;
  expiresAt: string;
  certificationBody: string;
  certifiedScope?: string;
}

export interface ActivityPatchBody {
  auditeeHandle?: string;
  auditorHandle?: string;
  targetCode?: string | null;
  scheduledAt?: string | null;
  status?: ActivityStatus;
  note?: string | null;
}

export interface ItemPatchBody {
  ownerHandle?: string;
  dueAt?: string;
}

export interface TimelineAdapter {
  readonly sample: boolean;
  cycles(ms: MsId): Promise<Result<CycleModel[]>>;
  eventDetail(ms: MsId, event: EventModel): Promise<Result<EventDetail>>;
  createEvent(ms: MsId, body: EventCreateBody, idempotencyKey: string): Promise<Result<Outcome>>;
  updateEvent(ms: MsId, event: EventModel, patch: EventPatchBody): Promise<Result<Outcome>>;
  activities(ms: MsId, event: EventModel): Promise<Result<ActivityModel[]>>;
  generate(ms: MsId, event: EventModel): Promise<Result<Outcome>>;
  updateActivity(ms: MsId, activity: ActivityModel, patch: ActivityPatchBody): Promise<Result<Outcome>>;
  startCycle(ms: MsId, body: { cycleStart: string; cycleEnd?: string }, idempotencyKey: string): Promise<Result<Outcome>>;
  recordCertificate(ms: MsId, body: CertificateBody): Promise<Result<Outcome>>;
  transition(ms: MsId, cycle: CycleModel, to: CycleMove, reason: string): Promise<Result<Outcome>>;
  markDone(ms: MsId, item: ItemModel): Promise<Result<Outcome>>;
  updateItem(ms: MsId, item: ItemModel, patch: ItemPatchBody): Promise<Result<Outcome>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The same day `n` years later (29 February becomes 28 February in other years). */
export function addYears(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const year = y + n;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The organisation's date of today: the snapshot's, else the browser's. */
export function todayOf(ctx: Pick<HostContext, 'D'>): string {
  return ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
}

/** A date as the screens show it (`14 Mar 2025`), or `-`. */
export function fmtDate(ctx: Pick<HostContext, 'D' | 'lang'>, iso: string | null | undefined): string {
  if (!iso) return '-';
  return ctx.D?.fmt ? ctx.D.fmt(iso, ctx.lang) : iso;
}

// ---------------------------------------------------------------------------------------------------------------
// Cycles and events
// ---------------------------------------------------------------------------------------------------------------

const textEn = (t: AuditEvent['t'] | undefined | null): string => (Array.isArray(t) ? String(t[0] ?? '') : String(t ?? ''));

/**
 * The event behind a timeline row: the event of a cycle with the row's date and short label (the api's `EVENTS` row
 * carries the short label as its title), else the only event of that date. Null when no cycle lists it.
 */
export function resolveEvent(cycles: readonly CycleModel[], ms: MsId, index: number, row: Pick<AuditEvent, 't' | 'short' | 'd'>): EventModel | null {
  const candidates: { event: CycleEvent; cycle: CycleModel }[] = [];
  for (const cycle of cycles) for (const event of cycle.events) if (event.scheduledAt === row.d) candidates.push({ event, cycle });
  if (!candidates.length) return null;
  const labels = new Set([textEn(row.t), textEn(row.short)].filter(Boolean));
  const hit = candidates.find((c) => labels.has(c.event.shortLabel)) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!hit) return null;
  return { ...hit.event, ms, cycleId: hit.cycle.id, index };
}

/** The cycle the next audits belong to: active, else planned. */
export const activeCycle = (cycles: readonly CycleModel[]): CycleModel | null => cycles.find((c) => c.status === 'active') ?? null;
export const plannedCycle = (cycles: readonly CycleModel[]): CycleModel | null => cycles.find((c) => c.status === 'planned') ?? null;

/** The cycle with the latest start (`ms.cycles.list` lists it first; the sample adapter adds new cycles last). */
export const newestCycle = (cycles: readonly CycleModel[]): CycleModel | null =>
  [...cycles].sort((a, b) => b.cycleStart.localeCompare(a.cycleStart))[0] ?? null;

/**
 * True when a certification cycle may start (D.4), as the page action "Start certification cycle" offers it: no cycle
 * of the system is active, and the newest cycle's certificate is not suspended, since a suspended certificate waits
 * for the certification body to reinstate or withdraw it (the cycle panel withholds the action the same way).
 */
export const cycleMayStart = (cycles: readonly CycleModel[]): boolean => !activeCycle(cycles) && newestCycle(cycles)?.status !== 'suspended';

/** The Stage 2 or recertification audit of a cycle with a recommended result, newest first (D.4). */
export function recommendation(cycle: CycleModel | null | undefined): CycleEvent | null {
  if (!cycle) return null;
  return [...cycle.events]
    .filter((e) => CERTIFYING_AUDITS.includes(e.eventType) && isRecommended(e.outcome))
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0] ?? null;
}

/** The expiry of a certificate as text: the date with the days left, today, or expired. */
export function expiryText(ctx: Pick<HostContext, 'D' | 'lang' | 'fill'>, expires: string | null, today: string): string {
  if (!expires) return ctx.fill(TEXT.notRecorded, {});
  const date = fmtDate(ctx, expires);
  const n = daysBetween(today, expires);
  if (n < 0) return ctx.fill(TEXT.expiredOn, { date });
  if (n === 0) return ctx.fill(TEXT.expiresToday, { date });
  return ctx.fill(TEXT.expiresIn, { date, n });
}

/** Days until the certificate expires when that is 90 days or fewer away (the expiry notices of D.4), else null. */
export function expiringSoon(cycle: CycleModel, today: string): number | null {
  if (cycle.status !== 'certified' || !cycle.certificateExpiresAt) return null;
  const n = daysBetween(today, cycle.certificateExpiresAt);
  return n >= 0 && n <= 90 ? n : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6)
// ---------------------------------------------------------------------------------------------------------------

type Who = Pick<HostContext, 'can' | 'me' | 'mode' | 'role' | 'person'>;

/** MS Managers add, change and record the result of the certification body's audits (`audit_event.manage`). */
export const mayManageEvents = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'audit_event.manage');
/** MS Managers record the certificate and its suspension, reinstatement and withdrawal (`ms.transition`). */
export const mayMoveCycle = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'ms.transition');

/** The business roles of the session in a system (API), or the sample persona's role. */
function rolesOf(ctx: Who, ms: MsId): readonly string[] {
  if (ctx.mode !== 'api') return ctx.role === 'manager' ? ['ms_manager'] : [];
  return (ctx.me?.rolesByMs?.[ms] ?? []) as readonly string[];
}

/** True for the MS Manager, who holds `prep_task.update` and `cycle_item.update` for every item (F.6). */
export function managesItems(ctx: Who, ms: MsId): boolean {
  return rolesOf(ctx, ms).includes('ms_manager');
}

/** "Mark done": the MS Manager, or the holder of the item with the own grant (Domain Owner, Internal Auditor). */
export function mayFinishItem(ctx: Who, item: Pick<ItemModel, 'kind' | 'ms' | 'owner'>): boolean {
  const perm = item.kind === 'prep' ? 'prep_task.update' : 'cycle_item.update';
  if (!ctx.can(item.ms, perm)) return false;
  return managesItems(ctx, item.ms) || (Boolean(item.owner) && item.owner === ctx.person.handle);
}

/** "Reassign or change due date": the MS Manager only. */
export function mayReassignItem(ctx: Who, item: Pick<ItemModel, 'kind' | 'ms'>): boolean {
  const perm = item.kind === 'prep' ? 'prep_task.update' : 'cycle_item.update';
  return ctx.can(item.ms, perm) && managesItems(ctx, item.ms);
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export type FormErrors<K extends string> = Partial<Record<K, TextPair>>;

const intIn = (text: string, min: number, max: number): boolean => /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;
const trimmed = (text: string): string => text.trim();

export interface EventForm {
  eventType: EventType;
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: string;
  leadAuditor: string;
  prepWindowDays: string;
  expectedFocus: string;
}

/** A new event of a type, with its default names and a preparation window of 60 days. */
export function emptyEventForm(eventType: EventType = 'stage1'): EventForm {
  const [nameEn, nameId, shortLabel] = EVENT_DEFAULTS[eventType];
  return { eventType, nameEn, nameId, shortLabel, scheduledAt: '', auditDays: '1', leadAuditor: '', prepWindowDays: '60', expectedFocus: '' };
}

/** A new type keeps the names the person typed; names still at the old type's defaults follow the new type. */
export function withType(form: EventForm, eventType: EventType): EventForm {
  const [oldEn, oldId, oldShort] = EVENT_DEFAULTS[form.eventType];
  const [nameEn, nameId, shortLabel] = EVENT_DEFAULTS[eventType];
  return {
    ...form,
    eventType,
    nameEn: !form.nameEn.trim() || form.nameEn === oldEn ? nameEn : form.nameEn,
    nameId: !form.nameId.trim() || form.nameId === oldId ? nameId : form.nameId,
    shortLabel: !form.shortLabel.trim() || form.shortLabel === oldShort ? shortLabel : form.shortLabel,
  };
}

export function eventFormOf(detail: EventDetail): EventForm {
  return {
    eventType: detail.eventType,
    nameEn: detail.nameEn,
    nameId: detail.nameId,
    shortLabel: detail.shortLabel,
    scheduledAt: detail.scheduledAt,
    auditDays: detail.auditDays === null ? '' : String(detail.auditDays),
    leadAuditor: detail.leadAuditor ?? '',
    prepWindowDays: detail.prepWindowDays === null ? '' : String(detail.prepWindowDays),
    expectedFocus: detail.expectedFocus ?? '',
  };
}

export function eventErrors(form: EventForm): FormErrors<keyof EventForm> {
  const out: FormErrors<keyof EventForm> = {};
  if (!trimmed(form.nameEn)) out.nameEn = TEXT.required;
  else if (trimmed(form.nameEn).length > 200) out.nameEn = TEXT.tooLong;
  if (trimmed(form.nameId).length > 200) out.nameId = TEXT.tooLong;
  if (!trimmed(form.shortLabel)) out.shortLabel = TEXT.required;
  else if (trimmed(form.shortLabel).length > 80) out.shortLabel = TEXT.tooLong;
  if (!ISO_DATE.test(form.scheduledAt)) out.scheduledAt = form.scheduledAt ? TEXT.badDate : TEXT.required;
  if (form.auditDays.trim() && !intIn(form.auditDays, 1, 365)) out.auditDays = TEXT.badDays;
  if (form.prepWindowDays.trim() && !intIn(form.prepWindowDays, 0, 365)) out.prepWindowDays = TEXT.badWindow;
  if (trimmed(form.leadAuditor).length > 150) out.leadAuditor = TEXT.tooLong;
  if (trimmed(form.expectedFocus).length > 4000) out.expectedFocus = TEXT.tooLong;
  return out;
}

/** `audit-events.create` of the form; the Indonesian name is the English one when left empty. */
export function createBody(form: EventForm): EventCreateBody {
  const nameEn = trimmed(form.nameEn);
  const body: EventCreateBody = {
    eventType: form.eventType,
    nameEn,
    nameId: trimmed(form.nameId) || nameEn,
    shortLabel: trimmed(form.shortLabel),
    scheduledAt: form.scheduledAt,
  };
  if (form.auditDays.trim()) body.auditDays = Number(form.auditDays);
  if (trimmed(form.leadAuditor)) body.leadAuditorName = trimmed(form.leadAuditor);
  if (trimmed(form.expectedFocus)) body.expectedFocus = trimmed(form.expectedFocus);
  if (form.prepWindowDays.trim()) body.prepWindowDays = Number(form.prepWindowDays);
  return body;
}

/** The members of `audit-events.update` that the form changes; null when nothing changed. */
export function eventPatch(detail: EventDetail, form: EventForm): EventPatchBody | null {
  const patch: EventPatchBody = {};
  const nameEn = trimmed(form.nameEn);
  const nameId = trimmed(form.nameId) || nameEn;
  if (form.eventType !== detail.eventType) patch.eventType = form.eventType;
  if (nameEn !== detail.nameEn) patch.nameEn = nameEn;
  if (nameId !== detail.nameId) patch.nameId = nameId;
  if (trimmed(form.shortLabel) !== detail.shortLabel) patch.shortLabel = trimmed(form.shortLabel);
  if (form.scheduledAt !== detail.scheduledAt) patch.scheduledAt = form.scheduledAt;
  const days = form.auditDays.trim() ? Number(form.auditDays) : null;
  if (days !== detail.auditDays) patch.auditDays = days;
  const lead = trimmed(form.leadAuditor) || null;
  if (lead !== (detail.leadAuditor ?? null)) patch.leadAuditorName = lead;
  const focus = trimmed(form.expectedFocus) || null;
  if (focus !== (detail.expectedFocus ?? null)) patch.expectedFocus = focus;
  if (form.prepWindowDays.trim() && Number(form.prepWindowDays) !== detail.prepWindowDays) patch.prepWindowDays = Number(form.prepWindowDays);
  return Object.keys(patch).length ? patch : null;
}

export interface ResultForm {
  outcome: AuditOutcome | '';
  summary: string;
}

export const resultFormOf = (detail: Pick<EventDetail, 'outcome' | 'outcomeSummary'>): ResultForm => ({ outcome: detail.outcome ?? '', summary: detail.outcomeSummary ?? '' });

/** The result members that changed; an empty choice or summary clears it (null). Null when nothing changed. */
export function resultPatch(detail: Pick<EventDetail, 'outcome' | 'outcomeSummary'>, form: ResultForm): EventPatchBody | null {
  const patch: EventPatchBody = {};
  const outcome = form.outcome || null;
  if (outcome !== (detail.outcome ?? null)) patch.outcome = outcome;
  const summary = trimmed(form.summary) || null;
  if (summary !== (detail.outcomeSummary ?? null)) patch.outcomeSummary = summary;
  return Object.keys(patch).length ? patch : null;
}

/** The hint under "Recommendation" for an audit type. */
export function resultHint(type: EventType): TextPair | null {
  if (type === 'stage1') return TEXT.hintStage1;
  if (CERTIFYING_AUDITS.includes(type)) return TEXT.hintCert;
  if (type === 'surveillance') return TEXT.hintSurveillance;
  return null;
}

export interface StartForm {
  cycleStart: string;
  cycleEnd: string;
}

export function startErrors(form: StartForm): FormErrors<keyof StartForm> {
  const out: FormErrors<keyof StartForm> = {};
  if (!ISO_DATE.test(form.cycleStart)) out.cycleStart = form.cycleStart ? TEXT.badDate : TEXT.required;
  if (form.cycleEnd && !ISO_DATE.test(form.cycleEnd)) out.cycleEnd = TEXT.badDate;
  else if (form.cycleEnd && ISO_DATE.test(form.cycleStart) && form.cycleEnd <= form.cycleStart) out.cycleEnd = TEXT.endBeforeStart;
  return out;
}

export const startBody = (form: StartForm): { cycleStart: string; cycleEnd?: string } => (form.cycleEnd ? { cycleStart: form.cycleStart, cycleEnd: form.cycleEnd } : { cycleStart: form.cycleStart });

export interface CertificateForm {
  certificateNo: string;
  issuedAt: string;
  expiresAt: string;
  certificationBody: string;
  certifiedScope: string;
}

/** Issued today, expiring the day before the third anniversary, with the system's certification body and scope. */
export function emptyCertificate(today: string, body: string | null | undefined, scope: string | null | undefined): CertificateForm {
  return { certificateNo: '', issuedAt: today, expiresAt: addDays(addYears(today, 3), -1), certificationBody: body ?? '', certifiedScope: scope ?? '' };
}

export function certificateErrors(form: CertificateForm): FormErrors<keyof CertificateForm> {
  const out: FormErrors<keyof CertificateForm> = {};
  if (!trimmed(form.certificateNo)) out.certificateNo = TEXT.required;
  else if (trimmed(form.certificateNo).length > 60) out.certificateNo = TEXT.tooLong;
  if (!ISO_DATE.test(form.issuedAt)) out.issuedAt = form.issuedAt ? TEXT.badDate : TEXT.required;
  if (!ISO_DATE.test(form.expiresAt)) out.expiresAt = form.expiresAt ? TEXT.badDate : TEXT.required;
  else if (ISO_DATE.test(form.issuedAt) && form.expiresAt <= form.issuedAt) out.expiresAt = TEXT.expiresBeforeIssued;
  if (!trimmed(form.certificationBody)) out.certificationBody = TEXT.required;
  else if (trimmed(form.certificationBody).length > 200) out.certificationBody = TEXT.tooLong;
  if (trimmed(form.certifiedScope).length > 4000) out.certifiedScope = TEXT.tooLong;
  return out;
}

export function certificateBody(form: CertificateForm): CertificateBody {
  const body: CertificateBody = {
    certificateNo: trimmed(form.certificateNo),
    issuedAt: form.issuedAt,
    expiresAt: form.expiresAt,
    certificationBody: trimmed(form.certificationBody),
  };
  if (trimmed(form.certifiedScope)) body.certifiedScope = trimmed(form.certifiedScope);
  return body;
}

/** A reason of 3 to 1000 characters (`CycleTransitionRequest`). */
export function reasonError(reason: string): TextPair | null {
  const r = trimmed(reason);
  if (r.length < 3) return TEXT.reasonShort;
  if (r.length > 1000) return TEXT.tooLong;
  return null;
}

export interface ActivityForm {
  auditee: string;
  auditor: string;
  targetCode: string;
  scheduledAt: string;
  status: ActivityStatus;
  note: string;
}

export const activityFormOf = (a: ActivityModel): ActivityForm => ({
  auditee: a.auditee ?? '',
  auditor: a.auditor ?? '',
  targetCode: a.targetCode ?? '',
  scheduledAt: a.scheduledAt ?? '',
  status: a.status,
  note: a.note ?? '',
});

/** The members of `audit-activities.update` that changed; `none` clears the auditor, null the target, date and note. */
export function activityPatch(a: ActivityModel, form: ActivityForm): ActivityPatchBody | null {
  const patch: ActivityPatchBody = {};
  if (form.auditee && form.auditee !== (a.auditee ?? '')) patch.auditeeHandle = form.auditee;
  if (form.auditor !== (a.auditor ?? '')) patch.auditorHandle = form.auditor || 'none';
  const target = trimmed(form.targetCode) || null;
  if (target !== (a.targetCode ?? null)) patch.targetCode = target;
  const date = form.scheduledAt || null;
  if (date !== (a.scheduledAt ?? null)) patch.scheduledAt = date;
  if (form.status !== a.status) patch.status = form.status;
  const note = trimmed(form.note) || null;
  if (note !== (a.note ?? null)) patch.note = note;
  return Object.keys(patch).length ? patch : null;
}

export function activityErrors(form: ActivityForm): FormErrors<keyof ActivityForm> {
  const out: FormErrors<keyof ActivityForm> = {};
  if (form.scheduledAt && !ISO_DATE.test(form.scheduledAt)) out.scheduledAt = TEXT.badDate;
  if (trimmed(form.targetCode).length > 30) out.targetCode = TEXT.tooLong;
  if (trimmed(form.note).length > 2000) out.note = TEXT.tooLong;
  return out;
}

export interface ItemForm {
  owner: string;
  due: string;
}

/** The holder and due date that changed; BR-43 keeps a preparation task before its audit. */
export function itemPatch(item: ItemModel, form: ItemForm): ItemPatchBody | null {
  const patch: ItemPatchBody = {};
  if (form.owner && form.owner !== item.owner) patch.ownerHandle = form.owner;
  if (form.due && form.due !== item.due) patch.dueAt = form.due;
  return Object.keys(patch).length ? patch : null;
}

export function itemErrors(item: ItemModel, form: ItemForm): FormErrors<keyof ItemForm> {
  const out: FormErrors<keyof ItemForm> = {};
  if (!form.owner) out.owner = TEXT.required;
  if (!ISO_DATE.test(form.due)) out.due = form.due ? TEXT.badDate : TEXT.required;
  return out;
}

/** True when a preparation task's due date breaks BR-43 (due on or after the audit). */
export const breaksBr43 = (item: Pick<ItemModel, 'kind' | 'auditDate'>, due: string): boolean =>
  item.kind === 'prep' && Boolean(item.auditDate) && ISO_DATE.test(due) && due >= (item.auditDate as string);

// ---------------------------------------------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------------------------------------------

/** The people of the organisation for pickers, without the unassigned entry. */
export function peopleOf(D: ControllerData | null | undefined): { id: string; name: string; jobTitle: string }[] {
  return Object.entries(D?.PEOPLE ?? {})
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => ({ id, name: p[0], jobTitle: p[1] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function personName(D: ControllerData | null | undefined, handle: string | null | undefined): string {
  if (!handle || handle === 'none') return '-';
  return D?.PEOPLE?.[handle]?.[0] ?? handle;
}

/** The text of a write's answer: the server's message when it gave one, else `fallback`, then its warnings. */
export function outcomeText(ctx: Pick<HostContext, 'li'>, outcome: Outcome, fallback: string): string {
  const head = outcome.message ? ctx.li(outcome.message) : fallback;
  const warnings = outcome.warnings.map((w) => `${w.rule}: ${ctx.li(w.message)}`);
  return [head, ...warnings].join(' ');
}

/** The organisation a sample or api cache belongs to: its id, else the systems of the snapshot. */
export function orgKeyOf(ctx: Pick<HostContext, 'org' | 'D'>): string {
  return ctx.org?.id ?? (ctx.D?.MS ?? []).map((m) => m.id).sort().join(',');
}

/** True for the 412 of a stale `If-Match` (R-18). */
export const isConflict = (error: ApiError | null | undefined): boolean => Boolean(error && (error.status === 412 || error.slug === 'precondition-failed'));
