// Sample adapter of the Company sign-in screen (MILESTONE-2 M2-10): the sample organisation signs in with Microsoft
// Entra ID (OIDC) and keeps a disabled AD FS provider (SAML); local sign-in is allowed. Changes stay for the browser
// session. A test of the OIDC provider reports the endpoints of its discovery document, a test of a provider whose
// issuer does not answer (any issuer on `.invalid`) fails as the api reports it.
import type { IdentityProviderPatch, IdentityProviderRequest } from '@mscd/shared';
import type { IdpAdapter, PolicyCode, PolicyModel, ProviderModel, Result, TestOutcome } from './model';

const ENTRA_TENANT = '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c';

function initialProviders(): ProviderModel[] {
  return [
    {
      id: 'sample-idp-entra', slug: 'entra', kind: 'oidc', displayName: 'Sign in with Microsoft', icon: 'microsoft', enabled: true,
      oidc: { issuer: `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`, clientId: 'mscd-sample', scopes: 'openid email profile', subjectMode: 'entra', entraTenantId: ENTRA_TENANT, clientSecretSet: true },
      saml: null, requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: true, allowedEmailDomains: ['nusantaradigital.co.id'], updatedAt: '2026-03-02T03:00:00Z',
    },
    {
      id: 'sample-idp-adfs', slug: 'adfs', kind: 'saml', displayName: 'Sign in with AD FS', icon: 'generic', enabled: false, oidc: null,
      saml: { entryPoint: 'https://adfs.nusantaradigital.co.id/adfs/ls/', idpIssuer: 'http://adfs.nusantaradigital.co.id/adfs/services/trust', idpCertCount: 1, spEntityId: 'https://mscd.nusantaradigital.co.id/api/v1/auth/saml/adfs/metadata', mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'] },
      requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [], updatedAt: '2026-01-15T03:00:00Z',
    },
  ];
}

let providers: ProviderModel[] | null = null;
let policy: PolicyCode = 'allowed';
let added = 0;

/** Forgets the changes of this session (unit tests). */
export function resetSampleIdp(): void {
  providers = null;
  policy = 'allowed';
  added = 0;
}

const all = () => (providers ??= initialProviders());
const copy = (p: ProviderModel): ProviderModel => ({ ...p, oidc: p.oidc ? { ...p.oidc } : null, saml: p.saml ? { ...p.saml, mfaAuthnContexts: [...p.saml.mfaAuthnContexts] } : null, allowedEmailDomains: [...p.allowedEmailDomains] });

/** The providers of the sample organisation for the pre-registration form of People and roles. */
export function sampleProviderRefs(): { slug: string; name: string; kind: 'oidc' | 'saml'; enabled: boolean }[] {
  return all().map((p) => ({ slug: p.slug, name: p.displayName, kind: p.kind, enabled: p.enabled }));
}

function refuse<T>(status: number, slug: string, message: [string, string], extra: { messageKey?: string; errors?: { path: string; message: string }[] } = {}): Result<T> {
  return { ok: false, error: { status, slug, message, ...extra } };
}

export function createSampleAdapter(): IdpAdapter {
  return {
    async list() {
      return { ok: true, data: all().map(copy) };
    },
    async create(body: IdentityProviderRequest) {
      if (all().some((p) => p.slug === body.slug)) {
        return refuse(409, 'conflict', ['The slug is already used by another identity provider', 'Slug sudah dipakai penyedia identitas lain'], { messageKey: 'idp.slug_taken' });
      }
      if (body.jitProvisioning && body.allowedEmailDomains?.some((d) => d !== 'nusantaradigital.co.id')) {
        const missing = body.allowedEmailDomains.filter((d) => d !== 'nusantaradigital.co.id').join(', ');
        return refuse(422, 'unprocessable', [`JIT provisioning needs verified domains; not verified for this organisation: ${missing}`, `Penyediaan JIT memerlukan domain terverifikasi; belum terverifikasi untuk organisasi ini: ${missing}`], { messageKey: 'idp.jit_domain_unverified' });
      }
      added += 1;
      const now = new Date().toISOString();
      const p: ProviderModel = {
        id: `sample-idp-new-${added}`, slug: body.slug, kind: body.kind, displayName: body.displayName, icon: body.icon, enabled: true,
        oidc: body.oidc ? { issuer: body.oidc.issuer, clientId: body.oidc.clientId, scopes: body.oidc.scopes, subjectMode: body.oidc.subjectMode, ...(body.oidc.entraTenantId ? { entraTenantId: body.oidc.entraTenantId } : {}), clientSecretSet: true } : null,
        saml: body.saml ? { entryPoint: body.saml.entryPoint, idpIssuer: body.saml.idpIssuer, idpCertCount: body.saml.idpCerts.length, spEntityId: body.saml.spEntityId, mfaAuthnContexts: [...body.saml.mfaAuthnContexts] } : null,
        requireMfaClaim: body.requireMfaClaim ?? true, mfaFallback: body.mfaFallback ?? 'local_totp', jitProvisioning: body.jitProvisioning ?? false,
        allowedEmailDomains: [...(body.allowedEmailDomains ?? [])], updatedAt: now,
      };
      all().push(p);
      return { ok: true, data: copy(p) };
    },
    async update(id: string, patch: IdentityProviderPatch) {
      const p = all().find((x) => x.id === id);
      if (!p) return refuse(404, 'not-found', ['Unknown identity provider', 'Penyedia identitas tidak dikenal']);
      if (patch.enabled !== undefined) p.enabled = patch.enabled;
      if (patch.displayName !== undefined) p.displayName = patch.displayName;
      p.updatedAt = new Date().toISOString();
      return { ok: true, data: copy(p) };
    },
    async test(id: string): Promise<Result<TestOutcome>> {
      const p = all().find((x) => x.id === id);
      if (!p) return refuse(404, 'not-found', ['Unknown identity provider', 'Penyedia identitas tidak dikenal']);
      const at = new Date().toISOString();
      if (p.kind === 'saml' && p.saml) {
        return { ok: true, data: { ok: true, issuer: p.saml.idpIssuer, endpoints: { singleSignOn: p.saml.entryPoint, serviceProviderMetadata: `/api/v1/auth/saml/${p.slug}/metadata` }, message: null, at } };
      }
      const issuer = p.oidc?.issuer ?? '';
      let host = '';
      try {
        host = new URL(issuer).hostname;
      } catch {
        host = '';
      }
      if (!host || host.endsWith('.invalid')) {
        return { ok: true, data: { ok: false, issuer, endpoints: {}, message: 'The issuer could not be reached', at } };
      }
      const base = issuer.replace(/\/v2\.0$/, '').replace(/\/$/, '');
      return {
        ok: true,
        data: {
          ok: true, issuer, message: null, at,
          endpoints: { authorization: `${base}/oauth2/v2.0/authorize`, token: `${base}/oauth2/v2.0/token`, userinfo: 'https://graph.microsoft.com/oidc/userinfo', jwks: `${base}/discovery/v2.0/keys`, endSession: `${base}/oauth2/v2.0/logout` },
        },
      };
    },
    async policy(): Promise<Result<PolicyModel>> {
      return { ok: true, data: { localLogin: policy, etag: null } };
    },
    async setPolicy(localLogin: PolicyCode): Promise<Result<PolicyModel>> {
      policy = localLogin;
      return { ok: true, data: { localLogin: policy, etag: null } };
    },
  };
}
