// The view model of "Policy read confirmations" (MILESTONE-3 M3-05, D.7) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build, chosen by the build in adapter.ts): the confirmation requests of
// a system with their totals, one request with the person list where the permission allows (product decisions 2 and
// 3), a request by hand, reminders, close and file as evidence, the register as CSV, and the read confirmation
// settings of a document. Types only from @mscd/shared (R-17). M3-14: each person has the day they were added and their
// own due date (newcomers join an open request), the excusal reasons stored by the server show in English and
// Indonesian, and the close dialog proposes the evidence item of the policy and warns about another policy's register;
// the register of a later request of a version also lists the confirmations of the earlier ones.
import type { AcknowledgementRole, AcknowledgementScope } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { BUSINESS_ROLE_LABELS } from '../roles';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

export type { AcknowledgementRole, AcknowledgementScope };

/** The screen id (C.2). */
export const SCREEN_ID = 'acknowledgements';

/** The icon of the screen and its page action: a document with a check mark. */
export const ICON = 'M6 3h8l4 4v14H6zM14 3v4h4M9 14l2 2 4-4';

/** The permissions that open the screen (C.2): manage, the person list, or the totals. */
export const SCREEN_PERMS = ['acknowledgement.manage', 'audit.pending.all', 'audit.pending.aggregate'] as const;
/** Asks, reminds and closes (F.6: Management System Manager). */
export const MANAGE_PERM = 'acknowledgement.manage';
/** Sees the person list and downloads the CSV (Management System Manager, Programme Owner). */
export const PEOPLE_PERM = 'audit.pending.all';
/** Changes the settings of a document (`documents.update`). */
export const DOCUMENT_PERM = 'document.manage';

/** The business roles that can be asked to confirm (J.7), in the order of the matrix. */
export const AUDIENCE_ROLES: readonly AcknowledgementRole[] = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator',
];
export const SCOPES: readonly AcknowledgementScope[] = ['system_roles', 'roles', 'organisation'];

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface Totals {
  audience: number;
  confirmed: number;
  pending: number;
  overdue: number;
  excused: number;
}

/** One confirmation request (`AcknowledgementRequestItem`). */
export interface RequestRow {
  id: string;
  /** The document's primary system. */
  ms: MsId;
  document: { id: string; code: string; title: string };
  version: { id: string; label: string };
  status: 'open' | 'closed';
  audienceScope: AcknowledgementScope;
  audienceRoles: AcknowledgementRole[] | null;
  dueOn: string;
  createdAt: string;
  lastRemindedAt: string | null;
  closedAt: string | null;
  evidenceId: string | null;
  totals: Totals;
}

export type PersonStatus = 'pending' | 'confirmed' | 'excused';

/** One person of a request (`AcknowledgementPerson`). */
export interface PersonRow {
  handle: string;
  name: string;
  status: PersonStatus;
  openedAt: string | null;
  confirmedAt: string | null;
  reminderCount: number;
  excusedReason: string | null;
  overdue: boolean;
  /** The day the person was added to the request (its start, or the day a newcomer joined, M3-14). */
  addedOn: string;
  /** The person's own due date: `addedOn` plus the request's period. */
  dueOn: string;
}

/** A request with its person list; `people` is absent without `audit.pending.all`. */
export interface RequestDetail extends RequestRow {
  people?: PersonRow[];
}

/** The read confirmation settings of a document (`DocumentAcknowledgement`). */
export interface Settings {
  required: boolean;
  scope: AcknowledgementScope;
  roles: AcknowledgementRole[] | null;
  dueDays: number;
}

export const DEFAULT_SETTINGS: Settings = { required: false, scope: 'system_roles', roles: null, dueDays: 14 };

/** The body of a request by hand (`AcknowledgementRequestCreate`). */
export interface AskInput {
  documentId: string;
  scope: AcknowledgementScope;
  roles: AcknowledgementRole[];
  dueDays: number;
}

/** What a write answered: the systems to load again, the count, the server's message and its data. */
export interface Outcome {
  changed: MsId[];
  count?: number;
  message: TextPair | null;
  warnings: TextPair[];
  data?: Record<string, unknown>;
}

/** A file to save: an address of the api, or a file made in the browser (the sample build). */
export interface Download {
  href: string;
  fileName: string;
  release?: () => void;
}

export interface AcknowledgementsAdapter {
  /** True for the sample adapter (the sample build). */
  readonly sample: boolean;
  list(ms: MsId): Promise<Result<RequestRow[]>>;
  get(ms: MsId, id: string): Promise<Result<RequestDetail>>;
  ask(ms: MsId, input: AskInput): Promise<Result<Outcome>>;
  remind(ms: MsId, id: string): Promise<Result<Outcome>>;
  close(ms: MsId, id: string, evidenceId: string | null): Promise<Result<Outcome>>;
  exportCsv(ms: MsId, request: RequestRow): Promise<Result<Download>>;
  /** Saves the settings of a document (by code); `confirm` after the BR-22 question of a shared document. */
  saveSettings(ms: MsId, code: string, settings: Settings, confirm: boolean): Promise<Result<Outcome>>;
  /** The settings of a document as this adapter knows them, or null when it does not know them. */
  settingsOf(ms: MsId, code: string, record: unknown): Settings | null;
  /** The id the routes take for a document (by code) or an evidence item (by code); null when unknown. */
  documentId(ms: MsId, code: string): string | null;
  evidenceId(ms: MsId, code: string): string | null;
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: Pick<HostContext, 'li'>, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/** A refusal with a message pair (sample rules and local checks). */
export function refusal(status: number, message: TextPair, extra: Partial<ApiError> = {}): { ok: false; error: ApiError } {
  return { ok: false, error: { status, message: [message[0], message[1]], ...extra } };
}

// -----------------------------------------------------------------------------------------------------------------
// Texts and tones
// -----------------------------------------------------------------------------------------------------------------

/** The label of a role. */
export function roleLabel(role: AcknowledgementRole): TextPair {
  return BUSINESS_ROLE_LABELS[role];
}

/** Who a request or a setting asks, in words. */
export function audienceText(ctx: Pick<HostContext, 'li' | 'fill'>, scope: AcknowledgementScope, roles: readonly AcknowledgementRole[] | null): string {
  if (scope === 'roles') {
    const names = (roles ?? []).map((r) => ctx.li(roleLabel(r))).join(', ');
    return ctx.fill(TEXT.rolesOf, { roles: names });
  }
  return ctx.li(scope === 'organisation' ? TEXT.scopeOrganisation : TEXT.scopeSystemRoles);
}

/**
 * The excusal reasons the server stores (`acknowledgement.excused_reason`, in English: the acknowledgement module and
 * the erasure of the privacy module) with their English and Indonesian texts (M3-14, texts B4). The stored values stay
 * as they are; "Replaced by version {v}" carries the version.
 */
export const EXCUSED_REASONS: Readonly<Record<string, TextPair>> = {
  'Membership of the organisation ended': ['Membership of the organisation ended', 'Keanggotaan di organisasi telah berakhir'],
  'No longer holds a role that is asked to confirm': ['No longer holds a role that is asked to confirm', 'Tidak lagi memegang peran yang diminta mengonfirmasi'],
  'The document is restricted to its owner, Management System Managers and Programme Owners': [
    'The document is restricted to its owner, Management System Managers and Programme Owners',
    'Dokumen dibatasi untuk pemiliknya, Management System Manager, dan Pemilik Program',
  ],
  'The person was erased at their request': ['The person was erased at their request', 'Data pribadi orang tersebut dihapus atas permintaannya'],
};

/** The texts of a stored excusal reason; an unknown reason shows as stored, in both languages. */
export function excusedReasonText(reason: string): TextPair {
  const known = EXCUSED_REASONS[reason];
  if (known) return known;
  const replaced = /^Replaced by version (.+)$/.exec(reason);
  if (replaced) return [`Replaced by version ${replaced[1]}`, `Diganti oleh versi ${replaced[1]}`];
  return [reason, reason];
}

/** The tone and label of a person's status (overdue for a pending person past the due date). */
export function personStatus(p: Pick<PersonRow, 'status' | 'overdue'>): { tone: Tone; label: TextPair } {
  if (p.status === 'confirmed') return { tone: 'ok', label: TEXT.personConfirmed };
  if (p.status === 'excused') return { tone: 'mute', label: TEXT.personExcused };
  return p.overdue ? { tone: 'bad', label: TEXT.personOverdue } : { tone: 'warn', label: TEXT.personPending };
}

/** The share of the audience that confirmed, in whole percent (0 without an audience). */
export function confirmedShare(t: Totals): number {
  const asked = t.audience - t.excused;
  return asked > 0 ? Math.round((t.confirmed / asked) * 100) : 0;
}

/** Requests of one document (by code), newest first. */
export function requestsOf(rows: readonly RequestRow[], code: string): RequestRow[] {
  return rows.filter((r) => r.document.code === code).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A day of an ISO date or instant in the interface language. */
export function dayOf(ctx: Pick<HostContext, 'D' | 'lang'>, iso: string | null): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** The approved documents of a system with a current version, for "Ask for confirmation". */
export function approvedDocuments(D: ControllerData | null, ms: MsId): { code: string; title: string; version: string }[] {
  const docs = D?.bundles?.[ms]?.docs ?? [];
  return docs
    .filter((d) => d.st === 'approved' && d.ver && d.ver !== '-')
    .map((d) => ({ code: d.id, title: d.title, version: d.ver }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/**
 * The evidence item proposed when a request of document `code` closes (M3-14, ISO review m3): the item the newest
 * earlier request of the same document was filed to, so each policy keeps its own item; null without one.
 */
export function proposedEvidenceId(rows: readonly RequestRow[], code: string, exceptId: string): string | null {
  return requestsOf(rows, code).find((r) => r.id !== exceptId && r.evidenceId)?.evidenceId ?? null;
}

/**
 * The code of another document whose register was filed to the evidence item `evidenceId`, from the request list of
 * the system (newest first); null when the item holds no other document's register (M3-14, ISO review m3).
 */
export function otherRegisterOf(rows: readonly RequestRow[], evidenceId: string | null, code: string): string | null {
  if (!evidenceId) return null;
  const hit = [...rows]
    .filter((r) => r.evidenceId === evidenceId && r.document.code !== code)
    .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))[0];
  return hit ? hit.document.code : null;
}

/**
 * How many people confirmed the version of `row` in earlier requests of the system's list (the same version, opened
 * before it). The register of `row` lists them too, so its file holds every confirmation of the version (M3-14); 0
 * without such a request. A person confirms a version once: a later request of it never asks them again.
 */
export function earlierConfirmedOf(rows: readonly RequestRow[], row: RequestRow): number {
  return rows
    .filter((r) => r.id !== row.id && r.version.id === row.version.id && r.createdAt < row.createdAt)
    .reduce((n, r) => n + r.totals.confirmed, 0);
}

/**
 * Whether "Ask the people who have not confirmed" fits a closed request (M3-14): the manager may ask, someone of the
 * request did not confirm, its version is still the document's current approved version, and the document has no open
 * request.
 */
export function mayAskAgain(rows: readonly RequestRow[], row: RequestRow, approved: readonly { code: string; version: string }[]): boolean {
  if (row.status !== 'closed' || row.totals.confirmed >= row.totals.audience) return false;
  if (!approved.some((d) => d.code === row.document.code && d.version === row.version.label)) return false;
  return !rows.some((r) => r.document.code === row.document.code && r.status === 'open');
}

/** The evidence items of a system, for "Close and file as evidence". */
export function evidenceItems(D: ControllerData | null, ms: MsId): { code: string; title: string }[] {
  const evs = D?.bundles?.[ms]?.evs ?? [];
  return evs.map((e) => ({ code: e.code, title: e.title })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/** The checks of "Ask for confirmation" before it is sent; null when it can be sent. */
export function askBlock(input: { documentId: string | null; scope: AcknowledgementScope; roles: readonly AcknowledgementRole[]; dueDays: string }): TextPair | null {
  if (!input.documentId) return TEXT.chooseDocument;
  if (input.scope === 'roles' && input.roles.length === 0) return TEXT.chooseRoles;
  const days = Number(input.dueDays);
  if (!/^\d+$/.test(input.dueDays.trim()) || days < 1 || days > 90) return TEXT.badDays;
  return null;
}

/** The settings of a form, as the api takes them (roles only for scope `roles`). */
export function settingsBody(s: Settings): Settings {
  return { required: s.required, scope: s.scope, roles: s.scope === 'roles' ? [...(s.roles ?? [])] : null, dueDays: s.dueDays };
}

/** Settings of a record of the snapshot (`acknowledgement` of the document, Milestone 3 D.2), or null. */
export function recordSettings(record: unknown): Settings | null {
  const a = (record as { acknowledgement?: Partial<Settings> } | null)?.acknowledgement;
  if (!a || typeof a.required !== 'boolean' || typeof a.scope !== 'string' || typeof a.dueDays !== 'number') return null;
  return { required: a.required, scope: a.scope as AcknowledgementScope, roles: a.roles ? [...a.roles] as AcknowledgementRole[] : null, dueDays: a.dueDays };
}
