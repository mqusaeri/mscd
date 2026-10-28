// API adapter of the My account screen through the host's client (R-17). The password change and the identity link
// answer 401 for a wrong password or a missing recent proof; those requests do not tell the session listeners, so the
// app stays signed in and the form shows the message.
import type { AuthProviders, CommandResult, IdentityLinkStart, MeSecurity, RecoveryCodesResponse } from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { NO_CLIENT, call } from '../api';
import type { RouteRef } from '../api';
import type { AccountAdapter, ProviderModel, Result, SecurityModel } from './model';
import { REENROL_PATH, ROUTES } from './routes';

/** A request whose 401 belongs to the form (wrong password, proof needed), not to the session. */
function send<T>(client: ApiClient | null, [method, path]: RouteRef, options: { params?: Record<string, string>; body?: unknown } = {}): Promise<ApiResult<T>> {
  if (!client) return Promise.resolve({ ok: false, status: 0, error: { status: 0, message: NO_CLIENT } });
  return client.request<T>(method, path, { ...options, notifyUnauthenticated: false });
}

const fail = <T,>(res: ApiResult<unknown> & { ok: false }): Result<T> => ({ ok: false, error: res.error });

export function fromSecurity(view: MeSecurity): SecurityModel {
  return {
    passwordSet: view.passwordSet,
    ssoOnly: view.ssoOnly,
    authenticatorSetUpAt: view.authenticatorSetUpAt,
    recoveryCodesLeft: view.recoveryCodesLeft,
    identities: view.identities.map((i) => ({ provider: i.provider, kind: i.kind, label: i.label, linkedAt: i.linkedAt })),
  };
}

/** Where the browser goes for an identity link or a re-enrolment; tests pass their own. */
export type Navigate = (url: string) => void;
const browserNavigate: Navigate = (url) => window.location.assign(url);

export function createApiAdapter(client: ApiClient | null, navigate: Navigate = browserNavigate): AccountAdapter {
  return {
    async security() {
      const res = await call<MeSecurity>(client, ROUTES.security);
      return res.ok ? { ok: true, data: fromSecurity(res.data) } : fail(res);
    },
    async providers(org) {
      const res = await call<AuthProviders>(client, ROUTES.providers, { query: org ? { org } : {} });
      if (!res.ok) return [];
      return res.data.providers.map((p): ProviderModel => ({ slug: p.slug, kind: p.kind, label: p.label }));
    },
    async changePassword(currentPassword, newPassword) {
      const res = await send(client, ROUTES.passwordChange, { body: { currentPassword, newPassword } });
      return res.ok ? { ok: true, data: null } : fail(res);
    },
    async recoveryCodes(code) {
      const res = await send<RecoveryCodesResponse>(client, ROUTES.recoveryCodes, { body: code ? { code } : {} });
      return res.ok ? { ok: true, data: [...res.data.codes] } : fail(res);
    },
    async savePreferences(preferences) {
      const res = await call(client, ROUTES.preferences, { body: { ...preferences } });
      return res.ok ? { ok: true, data: null } : fail(res);
    },
    async linkIdentity(slug) {
      const res = await send<IdentityLinkStart>(client, ROUTES.identityLink, { params: { slug } });
      if (!res.ok) return fail(res);
      navigate(res.data.redirectUrl);
      return { ok: true, data: res.data.redirectUrl };
    },
    async revokeCalendarFeed(ms) {
      const res = await call<CommandResult>(client, ROUTES.calendarRevoke, { params: { ms } });
      if (!res.ok) return fail(res);
      const message = res.data.message;
      return { ok: true, data: Array.isArray(message) && message.length === 2 ? [message[0], message[1]] : null };
    },
    replaceAuthenticator() {
      navigate(REENROL_PATH);
      return { ok: true, data: null };
    },
    async personEmail() {
      return null;
    },
  };
}
