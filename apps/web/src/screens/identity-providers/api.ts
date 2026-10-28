// API adapter of the Company sign-in screen (MILESTONE-2 M2-10): the identity provider routes (`admin.idp.*`) and the
// local sign-in policy of the organisation settings (`admin.organization.get` and `.update` with `If-Match`) through
// the host's client (R-17).
import type { IdentityProviderTestResult, IdentityProviderView, OrganizationSettings } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { IdpAdapter, ProviderModel, TestOutcome } from './model';
import { ROUTES } from './routes';

export function fromProviderView(view: IdentityProviderView): ProviderModel {
  return {
    id: view.id,
    slug: view.slug,
    kind: view.kind,
    displayName: view.displayName,
    icon: view.icon,
    enabled: view.enabled,
    oidc: view.oidc ? { ...view.oidc } : null,
    saml: view.saml ? { ...view.saml, mfaAuthnContexts: [...view.saml.mfaAuthnContexts] } : null,
    requireMfaClaim: view.requireMfaClaim,
    mfaFallback: view.mfaFallback,
    jitProvisioning: view.jitProvisioning,
    allowedEmailDomains: [...view.allowedEmailDomains],
    updatedAt: view.updatedAt,
  };
}

export function fromTestResult(result: IdentityProviderTestResult, at: string): TestOutcome {
  return { ok: result.ok, issuer: result.issuer, endpoints: { ...result.endpoints }, message: result.message ?? null, at };
}

export function createApiAdapter(client: ApiClient | null): IdpAdapter {
  const policy = async () => {
    const res = await call<OrganizationSettings>(client, ROUTES.orgGet);
    return res.ok ? { ok: true as const, data: { localLogin: res.data.localLogin, etag: res.data.etag } } : { ok: false as const, error: res.error };
  };
  return {
    async list() {
      const res = await call<IdentityProviderView[]>(client, ROUTES.list);
      return res.ok ? { ok: true, data: res.data.map(fromProviderView) } : { ok: false, error: res.error };
    },
    async create(body, idempotencyKey) {
      const res = await call<IdentityProviderView>(client, ROUTES.create, { body, idempotencyKey });
      return res.ok ? { ok: true, data: fromProviderView(res.data) } : { ok: false, error: res.error };
    },
    async update(id, patch) {
      const res = await call<IdentityProviderView>(client, ROUTES.update, { params: { id }, body: patch });
      return res.ok ? { ok: true, data: fromProviderView(res.data) } : { ok: false, error: res.error };
    },
    async test(id) {
      const res = await call<IdentityProviderTestResult>(client, ROUTES.test, { params: { id } });
      return res.ok ? { ok: true, data: fromTestResult(res.data, new Date().toISOString()) } : { ok: false, error: res.error };
    },
    policy,
    async setPolicy(localLogin, etag) {
      const res = await call<null>(client, ROUTES.orgUpdate, { body: { localLogin }, ifMatch: etag });
      if (!res.ok) return { ok: false, error: res.error };
      return policy();
    },
  };
}
