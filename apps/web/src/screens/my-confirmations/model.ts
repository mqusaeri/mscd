// The view model of "Policies to confirm" (MILESTONE-3 M3-05, D.7 "Confirming") and the interface both adapters
// implement (api.ts in API builds, sample.ts in the sample build, chosen in adapter.ts): the caller's open and recent
// confirmations, opening a version (a short-lived address, or none in the sample build) and the confirmation, which the
// server refuses before the version was opened (rule ACK-OPEN-FIRST, H.7). Types only from @mscd/shared (R-17).
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

/** The screen id (C.2). */
export const SCREEN_ID = 'my-confirmations';

/** The icon of the screen: a check mark in a circle. */
export const ICON = 'M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type ConfirmationStatus = 'pending' | 'confirmed' | 'excused';

/** One of the caller's confirmations (`MyAcknowledgementItem`). */
export interface Confirmation {
  id: string;
  requestId: string;
  /** The system the person's task is listed in. */
  ms: MsId;
  document: { code: string; title: string };
  versionLabel: string;
  status: ConfirmationStatus;
  dueOn: string;
  openedAt: string | null;
  confirmedAt: string | null;
  overdue: boolean;
}

export interface ConfirmationsAdapter {
  readonly sample: boolean;
  mine(): Promise<Result<Confirmation[]>>;
  /** The short-lived address of the version's file; null in the sample build, which has no stored files. */
  open(id: string): Promise<Result<{ url: string | null }>>;
  confirm(id: string): Promise<Result<{ message: TextPair | null; changed: MsId[] }>>;
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

/** The open confirmations (pending), overdue first, then by due date. */
export function openOf(list: readonly Confirmation[]): Confirmation[] {
  return list.filter((c) => c.status === 'pending').sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueOn.localeCompare(b.dueOn) || a.document.code.localeCompare(b.document.code));
}

/** The confirmations that are done: the confirmed ones newest first, then those no longer asked (newest due date first). */
export function doneOf(list: readonly Confirmation[]): Confirmation[] {
  const rank = (c: Confirmation) => (c.status === 'confirmed' ? 0 : 1);
  return list
    .filter((c) => c.status !== 'pending')
    .sort((a, b) => rank(a) - rank(b) || (b.confirmedAt ?? b.dueOn).localeCompare(a.confirmedAt ?? a.dueOn));
}

/** Why "Confirm" cannot be used yet, or null (H.7: open first, then the statement). */
export function confirmBlock(c: Pick<Confirmation, 'openedAt'>, opened: boolean, ticked: boolean): TextPair | null {
  if (!c.openedAt && !opened) return TEXT.openFirst;
  if (!ticked) return TEXT.tickFirst;
  return null;
}

/** A day of an ISO date or instant in the interface language. */
export function dayOf(ctx: Pick<HostContext, 'D' | 'lang'>, iso: string | null): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}
