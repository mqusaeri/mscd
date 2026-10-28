// The view model of the Auditor access screen (MILESTONE-2 M2-15) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6).
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import type { Tone } from '../ui';
import type { Download } from './shared';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A guest auditor grant of the system (`auditor-access.list`), without its token. */
export interface GrantModel {
  id: string;
  email: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  linkUsedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  active: boolean;
}

export type GrantState = 'active' | 'revoked' | 'expired';
export const GRANT_STATE_TEXT: Readonly<Record<GrantState, TextPair>> = { active: TEXT.sActive, revoked: TEXT.sRevoked, expired: TEXT.sExpired };
export const GRANT_STATE_TONE: Readonly<Record<GrantState, Tone>> = { active: 'ok', revoked: 'mute', expired: 'mute' };

/** Revoked, else the api's `active` (not revoked and before its expiry when it was read), else expired. */
export function grantState(g: Pick<GrantModel, 'active' | 'revokedAt'>): GrantState {
  if (g.revokedAt) return 'revoked';
  return g.active ? 'active' : 'expired';
}

export const PACK_STATUSES = ['queued', 'building', 'ready', 'failed'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];
export const PACK_STATUS_TEXT: Readonly<Record<PackStatus, TextPair>> = { queued: TEXT.pQueued, building: TEXT.pBuilding, ready: TEXT.pReady, failed: TEXT.pFailed };
export const PACK_STATUS_TONE: Readonly<Record<PackStatus, Tone>> = { queued: 'info', building: 'info', ready: 'ok', failed: 'bad' };

export type PackFile = 'manifest_pdf' | 'manifest_csv' | 'archive';
export const PACK_FILE_TEXT: Readonly<Record<PackFile, TextPair>> = { manifest_pdf: TEXT.manifestPdf, manifest_csv: TEXT.manifestCsv, archive: TEXT.archive };

/** An evidence pack of the system (`evidence-packs.list`). */
export interface PackModel {
  id: string;
  status: PackStatus;
  builtAt: string | null;
  packFolder: string | null;
  itemCount: number;
  exceptionCount: number;
  /** The files the pack offers, in the order the screen shows them. */
  files: PackFile[];
}

export interface PackPage {
  items: PackModel[];
  total: number;
}

export interface GrantBody {
  email: string;
  expiresInDays: number;
}

export interface GrantOutcome {
  grantId: string | null;
  expiresAt: string | null;
  message: TextPair | null;
}

export interface AuditorAccessAdapter {
  readonly sample: boolean;
  grants(ms: MsId): Promise<Result<GrantModel[]>>;
  grant(ms: MsId, body: GrantBody, idempotencyKey: string): Promise<Result<GrantOutcome>>;
  revoke(ms: MsId, grant: GrantModel): Promise<Result<true>>;
  packs(ms: MsId, page: number, pageSize: number): Promise<Result<PackPage>>;
  download(ms: MsId, pack: PackModel, file: PackFile): Promise<Result<Download>>;
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

export function asApiResult<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }));
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6)
// ---------------------------------------------------------------------------------------------------------------

/** MS Managers grant and revoke guest auditor access (`auditor_access.grant`). */
export const mayGrant = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'auditor_access.grant');

// ---------------------------------------------------------------------------------------------------------------
// The grant form
// ---------------------------------------------------------------------------------------------------------------

export interface GrantForm {
  email: string;
  days: string;
}

export const emptyGrant = (): GrantForm => ({ email: '', days: '14' });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function grantErrors(form: GrantForm): Partial<Record<keyof GrantForm, TextPair>> {
  const out: Partial<Record<keyof GrantForm, TextPair>> = {};
  const email = form.email.trim();
  if (!email || !EMAIL.test(email) || email.length > 254) out.email = TEXT.badEmail;
  if (!/^\d+$/.test(form.days.trim()) || Number(form.days) < 1 || Number(form.days) > 30) out.days = TEXT.badDays;
  return out;
}

export const grantBody = (form: GrantForm): GrantBody => ({ email: form.email.trim(), expiresInDays: Number(form.days) });
