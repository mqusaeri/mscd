// The model of the invitation banner (MILESTONE-2 M2-16): the invited memberships of other organisations that wait
// for the session user (`Me.pendingMemberships`, D.2), and the accept and decline calls.
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';

export interface Invitation {
  org: string;
  name: string;
  invitedBy: string | null;
  invitedAt: string;
}

export type Result = { ok: true } | { ok: false; error: ApiError };

export interface InvitationsAdapter {
  accept(org: string): Promise<Result>;
  decline(org: string): Promise<Result>;
}

/** Invitations accepted, declined or put off in this page session, per user (Me is read again only on the next start). */
const handled = new Set<string>();
const keyOf = (ctx: HostContext, org: string) => `${ctx.me?.user.id ?? ctx.person.handle}:${org}`;

export function markHandled(ctx: HostContext, org: string): void {
  handled.add(keyOf(ctx, org));
}

/** Forgets the handled invitations (unit tests). */
export function resetHandled(): void {
  handled.clear();
}

/** The invitations the banner shows: those of `Me` not handled in this page session, oldest first. */
export function pendingOf(ctx: HostContext): Invitation[] {
  const list = (ctx.me as unknown as { pendingMemberships?: Invitation[] } | null)?.pendingMemberships ?? [];
  return list.filter((i) => i && typeof i.org === 'string' && !handled.has(keyOf(ctx, i.org)));
}
