// The view model of Personal data requests (MILESTONE-3 M3-04, D.6) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build): the register of requests, the members a request can name, recording a
// request, one request with its system checks and the steps taken, the moves of J.8 and the actions of each type. The
// helpers give the time left, the actions a request offers and the checks of the record form.
import type { ApiResult } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

export type RequestType = 'access' | 'rectification' | 'restriction' | 'erasure';
export type RequestStatus = 'received' | 'in_progress' | 'completed' | 'refused' | 'withdrawn';
export type Channel = 'self_service' | 'email' | 'letter' | 'provider' | 'other';

export const TYPES: readonly RequestType[] = ['access', 'rectification', 'restriction', 'erasure'];
export const STATUSES: readonly RequestStatus[] = ['received', 'in_progress', 'completed', 'refused', 'withdrawn'];
/** The channels a Tenant Admin records; `self_service` comes from My account only. */
export const RECORD_CHANNELS: readonly Exclude<Channel, 'self_service'>[] = ['email', 'letter', 'provider', 'other'];

export const TYPE_TEXT: Readonly<Record<RequestType, TextPair>> = {
  access: TEXT.typeAccess, rectification: TEXT.typeRectification, restriction: TEXT.typeRestriction, erasure: TEXT.typeErasure,
};
export const STATUS_TEXT: Readonly<Record<RequestStatus, TextPair>> = {
  received: TEXT.statusReceived, in_progress: TEXT.statusInProgress, completed: TEXT.statusCompleted, refused: TEXT.statusRefused, withdrawn: TEXT.statusWithdrawn,
};
export const CHANNEL_TEXT: Readonly<Record<Channel, TextPair>> = {
  self_service: TEXT.channelSelf, email: TEXT.channelEmail, letter: TEXT.channelLetter, provider: TEXT.channelProvider, other: TEXT.channelOther,
};

export interface Person {
  handle: string;
  displayName: string;
}

export interface Subject {
  kind: 'member' | 'other';
  userId: string | null;
  handle: string | null;
  name: string;
  email: string | null;
}

export interface RequestRow {
  id: string;
  requestNo: string;
  type: RequestType;
  status: RequestStatus;
  subject: Subject;
  channel: Channel;
  receivedAt: string;
  dueAt: string;
  closedAt: string | null;
  handledBy: Person | null;
  overdue: boolean;
  etag: string;
}

export interface CheckView {
  id: string;
  ms: string;
  status: 'open' | 'done';
  doneBy: Person | null;
  doneAt: string | null;
  note: string | null;
}

export interface ActionView {
  action: string;
  at: string;
  actor: Person | null;
}

export interface RequestDetail extends RequestRow {
  note: string | null;
  identityCheckNote: string | null;
  identityCheckedBy: Person | null;
  outcome: string | null;
  result: Record<string, number> | null;
  checks: CheckView[];
  actions: ActionView[];
  exportTaskId: string | null;
}

/** A member a request can name (the subject picker). */
export interface Member {
  id: string;
  handle: string;
  name: string;
  email: string;
}

export interface ListFilter {
  status: RequestStatus | 'open' | '';
  type: RequestType | '';
  q: string;
}

export type SubjectInput = { userId: string } | { name: string; email?: string };

export interface RecordInput {
  type: RequestType;
  subject: SubjectInput;
  receivedAt: string;
  channel: Exclude<Channel, 'self_service'>;
  note?: string;
}

export type Patch =
  | { action: 'start'; identityCheckNote: string }
  | { action: 'refuse'; reason: string }
  | { action: 'withdraw'; reason: string }
  | { action: 'note'; note: string };

/** What a command answers: the server's message, and the task of a queued export. */
export interface Outcome {
  message: TextPair | null;
  taskId?: string;
}

/** The state of a person export (`GET /exports/{taskId}`). */
export interface ExportState {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  downloadUrl: string | null;
}

export interface PrivacyRequestsAdapter {
  readonly sample?: boolean;
  list(filter: ListFilter): Promise<ApiResult<RequestRow[]>>;
  members(): Promise<ApiResult<Member[]>>;
  create(input: RecordInput): Promise<ApiResult<{ id: string; requestNo: string }>>;
  get(id: string): Promise<ApiResult<RequestDetail>>;
  update(id: string, patch: Patch, etag: string | null): Promise<ApiResult<Outcome>>;
  rectify(id: string, body: { displayName?: string; jobTitle?: string | null }): Promise<ApiResult<Outcome>>;
  restrict(id: string): Promise<ApiResult<Outcome>>;
  erase(id: string): Promise<ApiResult<Outcome>>;
  close(id: string, outcome: string): Promise<ApiResult<Outcome>>;
  exportPerson(id: string): Promise<ApiResult<Outcome>>;
  exportState(taskId: string): Promise<ApiResult<ExportState>>;
}

/** The badge tone of a status. */
export function statusTone(status: RequestStatus): 'ok' | 'warn' | 'mute' | 'acc' {
  if (status === 'completed') return 'ok';
  if (status === 'in_progress') return 'acc';
  if (status === 'received') return 'warn';
  return 'mute';
}

/** True while a request is being answered. */
export function isOpen(status: RequestStatus): boolean {
  return status === 'received' || status === 'in_progress';
}

const HOUR = 3_600_000;

/** The time left of a request at `now`: hours or days and hours, the time it is overdue by, or when it was answered. */
export function timeLeft(ctx: Pick<HostContext, 'fill'>, row: Pick<RequestRow, 'status' | 'dueAt' | 'closedAt'>, now: number, day: (iso: string) => string): { text: string; tone: 'ok' | 'warn' | 'bad' | 'mute' } {
  if (!isOpen(row.status)) return { text: row.closedAt ? ctx.fill(TEXT.answeredOn, { date: day(row.closedAt) }) : '-', tone: 'mute' };
  const left = new Date(row.dueAt).getTime() - now;
  if (left < 0) {
    const late = -left;
    const by = late >= 24 * HOUR ? ctx.fill(TEXT.days, { n: Math.floor(late / (24 * HOUR)) }) : ctx.fill(TEXT.hours, { n: Math.max(1, Math.floor(late / HOUR)) });
    return { text: ctx.fill(TEXT.overdueBy, { n: by }), tone: 'bad' };
  }
  const hours = Math.floor(left / HOUR);
  const text = hours >= 24 ? ctx.fill(TEXT.leftDays, { d: Math.floor(hours / 24), h: hours % 24 }) : ctx.fill(TEXT.leftHours, { h: hours });
  return { text, tone: hours < 24 ? 'warn' : 'ok' };
}

/** The actions a request offers now; each has a reason when it cannot run yet. */
export interface Actions {
  start: boolean;
  refuse: boolean;
  withdraw: boolean;
  note: boolean;
  exportData: { shown: boolean; waits: TextPair | null };
  rectify: { shown: boolean; waits: TextPair | null };
  restrict: { shown: boolean; waits: TextPair | null };
  erase: { shown: boolean; waits: TextPair | null };
  close: { shown: boolean; waits: TextPair | null };
}

export function actionsFor(detail: RequestDetail): Actions {
  const open = isOpen(detail.status);
  const started = detail.status === 'in_progress';
  const member = detail.subject.kind === 'member';
  const checksOpen = detail.checks.some((c) => c.status === 'open');
  const result = detail.result ?? {};
  const wait = (...reasons: (TextPair | null | false)[]): TextPair | null => (reasons.find((r): r is TextPair => Boolean(r)) ?? null);
  const done = (key: string) => (result[key] ?? 0) > 0;
  const actionDone =
    detail.type === 'rectification' ||
    (detail.type === 'access' && (!member || done('exportsQueued'))) ||
    (detail.type === 'erasure' && done('erased')) ||
    (detail.type === 'restriction' && (!member || done('restricted')));
  return {
    start: detail.status === 'received',
    refuse: open,
    withdraw: open,
    note: true,
    exportData: { shown: open && detail.type === 'access' && member, waits: wait(!started && TEXT.startFirst) },
    rectify: { shown: open && detail.type === 'rectification' && member, waits: wait(!started && TEXT.startFirst) },
    restrict: { shown: open && detail.type === 'restriction' && member && !done('restricted'), waits: wait(!started && TEXT.startFirst) },
    erase: { shown: open && detail.type === 'erasure' && !done('erased'), waits: wait(!started && TEXT.startFirst, checksOpen && TEXT.waitChecks) },
    close: {
      shown: open,
      waits: wait(
        !started && TEXT.startFirst,
        (detail.type === 'access' || detail.type === 'erasure') && checksOpen && TEXT.waitChecks,
        !actionDone && detail.type === 'access' && TEXT.needExport,
        !actionDone && detail.type === 'erasure' && TEXT.needErase,
        !actionDone && detail.type === 'restriction' && TEXT.needRestrict,
      ),
    },
  };
}

/** Problems of the record form, by field. */
export function recordErrors(form: { kind: 'member' | 'other'; userId: string; name: string; email: string; date: string }): Partial<Record<'userId' | 'name' | 'email' | 'date', TextPair>> {
  const out: Partial<Record<'userId' | 'name' | 'email' | 'date', TextPair>> = {};
  if (form.kind === 'member' && !form.userId) out.userId = TEXT.chooseMember;
  if (form.kind === 'other' && !form.name.trim()) out.name = TEXT.required;
  if (form.kind === 'other' && form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) out.email = TEXT.required;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) out.date = TEXT.required;
  return out;
}

/** The instant of a local date and time (`2026-10-30`, `09:30`) in the browser's time zone. */
export function instantOf(date: string, time: string): string {
  const [h, m] = (time || '00:00').split(':').map((n) => Number(n));
  const at = new Date(`${date}T00:00:00`);
  at.setHours(h || 0, m || 0, 0, 0);
  return at.toISOString();
}

/** The body of a create command. */
export function recordBody(form: { type: RequestType; kind: 'member' | 'other'; userId: string; name: string; email: string; date: string; time: string; channel: RecordInput['channel']; note: string }): RecordInput {
  const subject: SubjectInput = form.kind === 'member'
    ? { userId: form.userId }
    : { name: form.name.trim(), ...(form.email.trim() ? { email: form.email.trim() } : {}) };
  return { type: form.type, subject, receivedAt: instantOf(form.date, form.time), channel: form.channel, ...(form.note.trim() ? { note: form.note.trim() } : {}) };
}

/** Rows of a list filter, in the order of the server: open first by due time, closed ones newest first. */
export function filterRows(rows: readonly RequestRow[], filter: ListFilter): RequestRow[] {
  const q = filter.q.trim().toLowerCase();
  return rows.filter((r) =>
    (filter.status === '' || (filter.status === 'open' ? isOpen(r.status) : r.status === filter.status)) &&
    (filter.type === '' || r.type === filter.type) &&
    (!q || [r.requestNo, r.subject.name, r.subject.handle, r.subject.email].some((v) => v?.toLowerCase().includes(q))));
}

/** The text of the result counts of a request (what was done), for the steps card. */
export const RESULT_TEXT: Readonly<Record<string, TextPair>> = {
  exportsQueued: ['Copies prepared', 'Salinan disiapkan'],
  rectified: ['Corrections', 'Koreksi'],
  fieldsChanged: ['Fields changed', 'Kolom diubah'],
  restricted: ['Membership disabled', 'Keanggotaan dinonaktifkan'],
  sessionsEnded: ['Sessions ended', 'Sesi diakhiri'],
  erased: ['Erased', 'Dihapus'],
  rolesRevoked: ['Roles revoked', 'Peran dicabut'],
  linkedSignInsRemoved: ['Linked sign-ins removed', 'Masuk tertaut dihapus'],
  invitationsRemoved: ['Invitations removed', 'Undangan dihapus'],
  confirmationsExcused: ['Read confirmations excused', 'Konfirmasi baca dibebaskan'],
  tasksCancelled: ['Tasks cancelled', 'Tugas dibatalkan'],
  notificationsDeleted: ['Notifications deleted', 'Notifikasi dihapus'],
  calendarFeedsDeleted: ['Calendar feeds deleted', 'Umpan kalender dihapus'],
  exportsWithdrawn: ['Copies of the data withdrawn', 'Salinan data ditarik'],
  auditEntriesRedacted: ['Audit entries redacted', 'Entri audit disamarkan'],
  platformEntriesRedacted: ['Sign-in and account entries redacted', 'Entri masuk dan akun disamarkan'],
  accountAnonymised: ['Account anonymised', 'Akun dianonimkan'],
  systemsChecked: ['Systems checked', 'Sistem diperiksa'],
};

/** The text of an action of the steps list (`privacy_request.created` gives "Recorded"). */
export const ACTION_TEXT: Readonly<Record<string, TextPair>> = {
  'privacy_request.created': ['Recorded', 'Dicatat'],
  'privacy_request.updated': ['Updated', 'Diperbarui'],
  'privacy_request.rectified': ['Account corrected', 'Akun dikoreksi'],
  'privacy_request.restricted': ['Membership disabled', 'Keanggotaan dinonaktifkan'],
  'privacy_request.erased': ['Person erased', 'Orang dihapus'],
  'privacy_request.closed': ['Completed', 'Selesai'],
};
