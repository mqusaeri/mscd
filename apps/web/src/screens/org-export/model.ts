// The view model of Organisation export (MILESTONE-3 M3-09, D.4) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6): the export statuses of the
// machine `organization_export.status` (J.8) with their texts and tones, who asked and who approved, sizes, the
// requester rule of H.2 ("You requested this export"), the checks of the forms, and the state of the read-only period
// that the banner of the host layer shows (`admin.organization.get`, D.2). The operator console reuses the status texts.
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { Download } from '../auditor-access/shared';
import type { HostContext, Lang, TextPair } from '../types';
import type { Tone } from '../ui';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const SCREEN_ID = 'org-export';
/** A box with an arrow out of it: everything leaves in one archive. */
export const ICON = 'M4 7h16v13H4zM4 7l2-3h12l2 3M12 10v6M9 13l3 3 3-3';

/** The states of `organization_export.status` (Milestone 3 J.7, J.8). */
export const EXPORT_STATUSES = ['requested', 'queued', 'building', 'ready', 'failed', 'rejected', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
/** Who asked for an export (`requested_via`). */
export const EXPORT_SOURCES = ['tenant_admin', 'operator', 'offboarding'] as const;
export type ExportSource = (typeof EXPORT_SOURCES)[number];

export const EXPORT_STATUS_TEXT: Readonly<Record<ExportStatus, TextPair>> = {
  requested: TEXT.statusRequested, queued: TEXT.statusQueued, building: TEXT.statusBuilding, ready: TEXT.statusReady, failed: TEXT.statusFailed,
  rejected: TEXT.statusRejected, expired: TEXT.statusExpired,
};
export const EXPORT_STATUS_TONE: Readonly<Record<ExportStatus, Tone>> = {
  requested: 'warn', queued: 'info', building: 'info', ready: 'ok', failed: 'bad', rejected: 'mute', expired: 'mute',
};
export const EXPORT_SOURCE_TEXT: Readonly<Record<ExportSource, TextPair>> = {
  tenant_admin: TEXT.viaTenantAdmin, operator: TEXT.viaOperator, offboarding: TEXT.viaOffboarding,
};

/** The worker builds a queued export; the list reads again this often while one is queued or being built. */
export const POLL_MS = 4000;
/** The longest note of a request or a decision (OrganizationExportCreate, OrganizationExportDecision). */
export const NOTE_MAX = 500;

/** A person named on an export; null for the system or an operator the customer does not know. */
export interface ExportPerson {
  handle: string;
  displayName: string;
}

/** `OrganizationExportItem`. */
export interface OrgExport {
  id: string;
  status: ExportStatus;
  requestedVia: ExportSource;
  requestedBy: ExportPerson | null;
  requestedAt: string;
  decidedBy: ExportPerson | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The final export queued by the move to offboarding; it stays until the organisation closes. */
  isFinal: boolean;
  partCount: number | null;
  fileCount: number | null;
  sizeBytes: number | null;
  expiresAt: string | null;
  completedAt: string | null;
  downloadCount: number;
  error: string | null;
}

/** `OrganizationExportPart`. */
export interface ExportPart {
  part: number;
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** `OrganizationExportDetail`: the export with its parts and the SHA-256 of its manifest. */
export interface OrgExportDetail extends OrgExport {
  parts: ExportPart[];
  manifestSha256: string | null;
}

/** What the screen and the banner read of `admin.organization.get` (Milestone 2 D.1, Milestone 3 D.2). */
export interface Lifecycle {
  activeAdminCount: number;
  /** While offboarding: the end of the read-only period; else null. */
  offboardingEndsAt: string | null;
  /** While offboarding the planned deletion date, while archived the scheduled one; else null. */
  deletionScheduledFor: string | null;
}

/** The answer of `exports.organization.create`. */
export interface Created {
  id: string;
  status: 'requested' | 'queued';
  approvalNeeded: boolean;
  message: TextPair | null;
}

/** The answer of `exports.organization.decide`. */
export interface Decided {
  id: string;
  status: 'queued' | 'rejected';
  message: TextPair | null;
}

export interface OrgExportAdapter {
  /** True for the sample adapter. */
  sample?: boolean;
  /** `admin.organization.get`: the admin count and the dates of the read-only period. */
  lifecycle(): Promise<Result<Lifecycle>>;
  /** `exports.organization.list`, newest first. */
  list(): Promise<Result<OrgExport[]>>;
  /** `exports.organization.get`. */
  get(id: string): Promise<Result<OrgExportDetail>>;
  /** `exports.organization.create` with an optional note and an idempotency key. */
  create(note: string | null, idempotencyKey: string): Promise<Result<Created>>;
  /** `exports.organization.decide`: approve, or reject with a note. */
  decide(id: string, approve: boolean, note: string | null): Promise<Result<Decided>>;
  /** The file of one part (`exports.organization.download`): an api link or a file made in the browser. */
  partFile(detail: OrgExportDetail, part: ExportPart): Promise<Result<Download>>;
  /** The manifest (`exports.organization.manifest`). */
  manifestFile(detail: OrgExportDetail): Promise<Result<Download>>;
}

/** A promise of a result that never rejects: a failed request answers a connection error. */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: Pick<HostContext, 'li'>, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/** The handle of the session person: the signed-in user (API) or the sample persona's person. */
export function selfHandle(ctx: Pick<HostContext, 'me' | 'person'>): string {
  return ctx.me?.user.handle ?? ctx.person.handle;
}

/** True when the session person asked for the export (the requester can never approve, H.2). */
export function isMine(e: Pick<OrgExport, 'requestedBy'>, handle: string): boolean {
  return Boolean(e.requestedBy && e.requestedBy.handle === handle);
}

/** True while MSCD still has work on an export: queued or being built. */
export const building = (e: Pick<OrgExport, 'status'>): boolean => e.status === 'queued' || e.status === 'building';

/** True when an export of the list is queued or being built (the screen reads the list again until it is ready). */
export function anyBuilding(list: readonly Pick<OrgExport, 'status'>[]): boolean {
  return list.some(building);
}

/** Who asked: the person's name, else the operator or the end of the contract. */
export function requesterText(ctx: Pick<HostContext, 'li'>, e: Pick<OrgExport, 'requestedBy' | 'requestedVia'>): string {
  if (e.requestedBy) return e.requestedBy.displayName;
  return ctx.li(EXPORT_SOURCE_TEXT[e.requestedVia]);
}

/** The approval of an export as one line: who approved or rejected, who decides, or why no approval was needed. */
export function approvalText(ctx: Pick<HostContext, 'li' | 'fill'>, e: Pick<OrgExport, 'status' | 'requestedVia' | 'decidedBy' | 'completedAt'>): string {
  if (e.decidedBy) return ctx.fill(e.status === 'rejected' ? TEXT.rejectedBy : TEXT.approvedBy, { name: e.decidedBy.displayName });
  if (e.status === 'requested') return ctx.li(TEXT.awaiting);
  // A request nobody decided within 7 days expires without ever being built.
  if (e.status === 'expired' && e.requestedVia === 'tenant_admin' && !e.completedAt) return ctx.li(TEXT.expiredWithout);
  if (e.requestedVia === 'operator') return ctx.li(TEXT.notNeededOperator);
  if (e.requestedVia === 'offboarding') return ctx.li(TEXT.notNeededFinal);
  return ctx.li(TEXT.notNeededSingle);
}

/** The parts of an export as text: "1 part", "3 parts", or nothing before it is built. */
export function partsText(ctx: Pick<HostContext, 'li' | 'fill'>, n: number | null): string {
  if (n === null) return '';
  return n === 1 ? ctx.li(TEXT.partOne) : ctx.fill(TEXT.partMany, { n });
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** A size in bytes as "734 B", "1.2 MB" or "1,2 MB" (Indonesian), with units of 1024; `-` when unknown. */
export function sizeText(bytes: number | null | undefined, lang: Lang): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const text = new Intl.NumberFormat(lang === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  return `${text} ${UNITS[unit]}`;
}

/** The error of an optional note before it is sent (at most 500 characters). */
export function noteError(note: string): TextPair | null {
  return note.trim().length > NOTE_MAX ? TEXT.noteLong : null;
}

/** The error of a rejection note before it is sent: required, at most 500 characters. */
export function rejectError(note: string): TextPair | null {
  if (!note.trim()) return TEXT.rejectNoteMissing;
  return noteError(note);
}

/** The date of an instant (its day in the browser's time zone) in the interface language. */
export function dayOf(ctx: Pick<HostContext, 'D' | 'lang'>, instant: string | null | undefined): string {
  if (!instant) return '-';
  const d = new Date(instant);
  const day = Number.isNaN(d.getTime())
    ? instant.slice(0, 10)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** Date and local time of an instant in the interface language. */
export function whenOf(ctx: Pick<HostContext, 'D' | 'lang'>, instant: string | null | undefined): string {
  if (!instant) return '-';
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return instant;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ctx.D ? ctx.D.fmt(local, ctx.lang) : local}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** True while the organisation is in its read-only period (the server sends the end only then). */
export const inReadOnlyPeriod = (l: Lifecycle | null | undefined): boolean => Boolean(l?.offboardingEndsAt);

/** A file name for a part when the list has none: the base of the manifest or of the first part. */
export function manifestName(detail: Pick<OrgExportDetail, 'parts' | 'id'>): string {
  const first = detail.parts[0]?.name;
  const base = first ? first.replace(/-part-\d+\.(tar\.gz|txt)$/, '') : `mscd-export-${detail.id.slice(0, 8)}`;
  return `${base}-manifest.json`;
}

export type { Download };
