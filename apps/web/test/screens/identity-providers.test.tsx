// Company sign-in (MILESTONE-2 M2-10): routes against the shared table, the OIDC and SAML form checks and the bodies of
// `IdentityProviderRequest` (D.2, F.5, F.9), the SAML metadata reader, the API adapter over a fake fetch (create with
// the Idempotency-Key, field errors kept, test, disable, the local sign-in policy with If-Match), the sample adapter
// and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityProviderRequest as RequestSchema, routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/identity-providers/index';
import { ROUTES, ROUTE_IDS, pathOf } from '../../src/screens/identity-providers/routes';
import { createApiAdapter, fromProviderView } from '../../src/screens/identity-providers/api';
import { createSampleAdapter, resetSampleIdp, sampleProviderRefs } from '../../src/screens/identity-providers/sample';
import { adapterFor, deferredAdapter, settled } from '../../src/screens/identity-providers/adapter';
import {
  certsOf, domainsOf, emptyOidc, emptySaml, endpointLabel, fillFromMetadata, forgetTests, isHttpUrl, lastTest, linesOf, oidcErrors, oidcRequest,
  parseSamlMetadata, rememberTest, samlErrors, samlRequest, serverFieldErrors, suggestSlug,
} from '../../src/screens/identity-providers/model';
import type { IdpAdapter, OidcForm, ProviderModel, SamlForm } from '../../src/screens/identity-providers/model';
import { OidcDrawer, PolicyCard, ProvidersTable, SamlDrawer, TestResultDialog, testText } from '../../src/screens/identity-providers/Screen';
import { TEXT } from '../../src/screens/identity-providers/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D: null, msObj: null, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'identity-providers', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const CERT = 'MIICmzCCAYMCBgGNdemoCertificateBodyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const METADATA = `<?xml version="1.0"?>
<!-- <md:SingleSignOnService Location="https://ignored.example/"/> -->
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://adfs.example.co.id/adfs/services/trust">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>ENCRYPTIONONLY</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
      ${CERT}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://adfs.example.co.id/adfs/ls/post"/>
    <md:SingleSignOnService Binding='urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect' Location='https://adfs.example.co.id/adfs/ls/?a=1&amp;b=2'/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const VIEW = {
  id: '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b', slug: 'keycloak', kind: 'oidc', displayName: 'Sign in with Keycloak', icon: 'generic', enabled: true,
  oidc: { issuer: 'https://sso.example.co.id/realms/mscd', clientId: 'mscd', scopes: 'openid email profile', subjectMode: 'sub', clientSecretSet: true },
  requireMfaClaim: true, acceptedAmr: ['otp'], mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [], createdAt: '2026-09-01T03:00:00Z', updatedAt: '2026-09-01T03:00:00Z',
} as const;

const oidcForm = (over: Partial<OidcForm> = {}): OidcForm => ({
  ...emptyOidc(), slug: 'keycloak', displayName: 'Sign in with Keycloak', issuer: 'https://sso.example.co.id/realms/mscd', clientId: 'mscd', clientSecret: 's3cret', ...over,
});
const samlForm = (over: Partial<SamlForm> = {}): SamlForm => ({
  ...emptySaml(), slug: 'adfs', displayName: 'Sign in with AD FS', entryPoint: 'https://adfs.example.co.id/adfs/ls/', idpIssuer: 'http://adfs.example.co.id/adfs/services/trust',
  idpCerts: CERT, spEntityId: 'https://mscd.example/api/v1/auth/saml/adfs/metadata', ...over,
});

afterEach(() => {
  resetSampleIdp();
  forgetTests();
});

describe('identity provider routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['list', 'create', 'update', 'test'] as const) expect(routeById(ROUTE_IDS[name]).permission).toBe('idp.manage');
    expect(routeById(ROUTE_IDS.orgUpdate)).toMatchObject({ permission: 'org.settings.manage', ifMatch: true });
    expect(pathOf(ROUTES.samlMetadata, 'adfs')).toBe('/api/v1/auth/saml/adfs/metadata');
    expect(pathOf(ROUTES.oidcCallback, '')).toBe('/api/v1/auth/oidc/<id>/callback');
  });
});

describe('the OIDC and SAML forms', () => {
  it('checks the OIDC form with the rules of IdentityProviderRequest and builds a body the schema accepts', () => {
    expect(oidcErrors(oidcForm())).toEqual({});
    expect(oidcErrors({ ...emptyOidc() })).toMatchObject({ slug: TEXT.required, displayName: TEXT.required, issuer: TEXT.required, clientId: TEXT.required, clientSecret: TEXT.required });
    expect(oidcErrors(oidcForm({ slug: 'Key_Cloak', issuer: 'ftp://x', scopes: 'email profile', subjectMode: 'entra', entraTenantId: 'x' }))).toEqual({ slug: TEXT.badSlug, issuer: TEXT.badUrl, scopes: TEXT.badScopes, entraTenantId: TEXT.badUuid });
    expect(oidcErrors(oidcForm({ requireMfaClaim: false, mfaFallback: 'reject' }))).toEqual({ mfaFallback: TEXT.rejectNeedsClaim });
    expect(oidcErrors(oidcForm({ jitProvisioning: true }))).toEqual({ domains: TEXT.needDomains });
    expect(oidcErrors(oidcForm({ jitProvisioning: true, domains: 'nusa.co.id, bad_domain' })).domains).toEqual(['Not an email domain: bad_domain', 'Bukan domain email: bad_domain']);
    const body = oidcRequest(oidcForm({ jitProvisioning: true, domains: '@Nusa.co.id nusa.co.id; other.id', subjectMode: 'entra', entraTenantId: '6F9E8D7C-6B5A-4F3E-9D2C-1B0A9F8E7D6C' }));
    expect(body).toMatchObject({ kind: 'oidc', allowedEmailDomains: ['nusa.co.id', 'other.id'], oidc: { subjectMode: 'entra', entraTenantId: '6f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c' } });
    expect(RequestSchema.safeParse(body).success).toBe(true);
    expect(RequestSchema.safeParse(oidcRequest(oidcForm())).success).toBe(true);
  });

  it('checks the SAML form, reads the certificates as PEM and never offers JIT', () => {
    expect(samlErrors(samlForm())).toEqual({});
    expect(samlErrors(samlForm({ entryPoint: 'x', idpCerts: 'not a cert', spEntityId: '' }))).toEqual({ entryPoint: TEXT.badUrl, idpCerts: TEXT.needCert, spEntityId: TEXT.required });
    const body = samlRequest(samlForm({ mfaAuthnContexts: 'http://schemas.microsoft.com/claims/multipleauthn\n\n' }));
    expect(body).toMatchObject({ kind: 'saml', jitProvisioning: false, allowedEmailDomains: [], saml: { mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'] } });
    expect(body.saml!.idpCerts[0]).toMatch(/^-----BEGIN CERTIFICATE-----\nMIIC[\s\S]+\n-----END CERTIFICATE-----$/);
    expect(RequestSchema.safeParse(body).success).toBe(true);
    const pem = `-----BEGIN CERTIFICATE-----\n${CERT}\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n${CERT}\n-----END CERTIFICATE-----`;
    expect(certsOf(pem)).toHaveLength(2);
    // A BEGIN and END pair with nothing between the markers is no certificate: the form asks for one.
    for (const empty of ['-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE----- -----END CERTIFICATE-----']) {
      expect(certsOf(empty)).toEqual([]);
      expect(samlErrors(samlForm({ idpCerts: empty }))).toEqual({ idpCerts: TEXT.needCert });
    }
    expect(certsOf(`-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n${pem}`)).toHaveLength(2);
    expect([linesOf(' a \n\n b'), domainsOf('A.id,, b.id a.id')]).toEqual([['a', 'b'], ['a.id', 'b.id']]);
    expect([isHttpUrl('https://x.id'), isHttpUrl('http://u:p@x.id'), isHttpUrl('https://x.id/#a'), isHttpUrl('mailto:a@b')]).toEqual([true, false, false, false]);
    expect([suggestSlug('Sign in with Microsoft'), suggestSlug('https://123.example.com'), suggestSlug('AD FS')]).toEqual(['microsoft', 'example-com', 'ad-fs']);
  });

  it('reads SAML metadata into the form: entity id, the HTTP-Redirect sign-on address and the signing certificate', () => {
    const meta = parseSamlMetadata(METADATA);
    expect(meta).toEqual({ idpIssuer: 'http://adfs.example.co.id/adfs/services/trust', entryPoint: 'https://adfs.example.co.id/adfs/ls/?a=1&b=2', certs: [CERT] });
    const { form, filled } = fillFromMetadata(emptySaml(), meta!);
    expect(form).toMatchObject({ idpIssuer: meta!.idpIssuer, entryPoint: meta!.entryPoint });
    expect(certsOf(form.idpCerts)).toHaveLength(1);
    expect(filled).toEqual([TEXT.idpIssuer, TEXT.entryPoint, TEXT.idpCerts]);
    expect(parseSamlMetadata('<html>no</html>')).toBeNull();
    expect(parseSamlMetadata('<EntityDescriptor entityID="x"><SPSSODescriptor/></EntityDescriptor>')).toBeNull();
    expect(parseSamlMetadata('<EntityDescriptor entityID="x"><IDPSSODescriptor><SingleSignOnService Location="https://a/b"/></IDPSSODescriptor></EntityDescriptor>')).toEqual({ idpIssuer: 'x', entryPoint: 'https://a/b', certs: [] });
  });

  it('maps the field errors of the server to the fields of the form', () => {
    const error = { status: 400, message: ['Validation failed', 'Validation failed'] as [string, string], errors: [{ path: 'body.oidc.issuer', message: 'Invalid URL' }, { path: 'body.allowedEmailDomains', message: 'JIT provisioning needs allowed email domains' }, { path: 'body.other', message: 'x' }] };
    expect(serverFieldErrors<OidcForm>(error, ['issuer', 'domains'])).toEqual({ issuer: 'Invalid URL', domains: 'JIT provisioning needs allowed email domains' });
    expect(endpointLabel('jwks')).toEqual(TEXT.endpoint_jwks);
    expect(endpointLabel('custom')).toEqual(['custom', 'custom']);
  });
});

describe('identity provider API adapter', () => {
  it('lists, creates with the Idempotency-Key, keeps the discovery refusal, tests, disables and sets the policy with If-Match', async () => {
    const discovery = problem(422, 'unprocessable', { messageKey: 'idp.discovery_failed', messages: { en: 'OpenID Connect discovery failed: The issuer could not be reached', id: 'Penemuan OpenID Connect gagal' } });
    const f = fakeFetch({
      'GET /api/v1/admin/identity-providers': json([VIEW]),
      'POST /api/v1/admin/identity-providers': [discovery, json(VIEW, 201)],
      [`PATCH /api/v1/admin/identity-providers/${VIEW.id}`]: json({ ...VIEW, enabled: false }),
      [`POST /api/v1/admin/identity-providers/${VIEW.id}/test`]: json({ ok: true, issuer: VIEW.oidc.issuer, endpoints: { authorization: 'https://sso/auth', jwks: 'https://sso/jwks' } }),
      'GET /api/v1/admin/organization': [json({ localLogin: 'allowed', etag: 'W/"1"' }), json({ localLogin: 'admins_only', etag: 'W/"2"' })],
      'PATCH /api/v1/admin/organization': [{ status: 204 }, problem(412, 'precondition-failed')],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    expect(await adapter.list()).toEqual({ ok: true, data: [fromProviderView(VIEW as never)] });
    const body = oidcRequest(oidcForm());
    expect(await adapter.create(body, 'idp-key')).toMatchObject({ ok: false, error: { status: 422, messageKey: 'idp.discovery_failed' } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', body, headers: { 'idempotency-key': 'idp-key', 'x-csrf-token': 'csrf-token-0123456789abcdef' } });
    expect(await adapter.create(body, 'idp-key')).toMatchObject({ ok: true, data: { slug: 'keycloak', oidc: { clientSecretSet: true } } });
    expect(await adapter.update(VIEW.id, { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(f.calls.at(-1)!.body).toEqual({ enabled: false });
    const tested = await adapter.test(VIEW.id);
    expect(tested).toMatchObject({ ok: true, data: { ok: true, endpoints: { jwks: 'https://sso/jwks' }, message: null, at: expect.any(String) } });
    expect(await adapter.policy()).toEqual({ ok: true, data: { localLogin: 'allowed', etag: 'W/"1"' } });
    expect(await adapter.setPolicy('admins_only', 'W/"1"')).toEqual({ ok: true, data: { localLogin: 'admins_only', etag: 'W/"2"' } });
    expect(f.calls.find((c) => c.method === 'PATCH' && c.path === '/api/v1/admin/organization')).toMatchObject({ body: { localLogin: 'admins_only' }, headers: { 'if-match': 'W/"1"' } });
    expect(await adapter.setPolicy('disabled', 'W/"1"')).toMatchObject({ ok: false, error: { status: 412 } });
  });
});

describe('identity provider sample adapter', () => {
  it('has an enabled OIDC and a disabled SAML provider, adds one, refuses a used short id and an unverified JIT domain', async () => {
    const adapter = createSampleAdapter();
    expect(sampleProviderRefs()).toEqual([{ slug: 'entra', name: 'Sign in with Microsoft', kind: 'oidc', enabled: true }, { slug: 'adfs', name: 'Sign in with AD FS', kind: 'saml', enabled: false }]);
    expect(await adapter.create(oidcRequest(oidcForm({ slug: 'entra' })), 'k')).toMatchObject({ ok: false, error: { status: 409, messageKey: 'idp.slug_taken' } });
    expect(await adapter.create(oidcRequest(oidcForm({ jitProvisioning: true, domains: 'other.id' })), 'k')).toMatchObject({ ok: false, error: { status: 422, messageKey: 'idp.jit_domain_unverified' } });
    const added = await adapter.create(samlRequest(samlForm({ slug: 'adfs2' })), 'k');
    expect(added).toMatchObject({ ok: true, data: { kind: 'saml', enabled: true, saml: { idpCertCount: 1 } } });
    const list = await adapter.list();
    expect(list.ok && list.data.map((p) => p.slug)).toEqual(['entra', 'adfs', 'adfs2']);
    expect(await adapter.update('sample-idp-entra', { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(await adapter.update('nope', { enabled: false })).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it('tests the OIDC discovery (and a failing issuer) and the SAML endpoints; keeps the local sign-in policy', async () => {
    const adapter = createSampleAdapter();
    expect(await adapter.test('sample-idp-entra')).toMatchObject({ ok: true, data: { ok: true, endpoints: { authorization: expect.stringContaining('/oauth2/v2.0/authorize') } } });
    expect(await adapter.test('sample-idp-adfs')).toMatchObject({ ok: true, data: { ok: true, endpoints: { singleSignOn: 'https://adfs.nusantaradigital.co.id/adfs/ls/', serviceProviderMetadata: '/api/v1/auth/saml/adfs/metadata' } } });
    const bad = await adapter.create(oidcRequest(oidcForm({ slug: 'dead', issuer: 'https://sso.dead.invalid/realm' })), 'k');
    if (!bad.ok) throw new Error('create failed');
    expect(await adapter.test(bad.data.id)).toMatchObject({ ok: true, data: { ok: false, message: 'The issuer could not be reached' } });
    expect(await adapter.policy()).toEqual({ ok: true, data: { localLogin: 'allowed', etag: null } });
    expect(await adapter.setPolicy('disabled', null)).toEqual({ ok: true, data: { localLogin: 'disabled', etag: null } });
  });

  it('the build chooses the adapter; a deferred adapter retries a failed module load', async () => {
    expect(await adapterFor(null).list()).toMatchObject({ ok: true });
    const load = vi.fn<() => Promise<IdpAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter());
    const adapter = deferredAdapter(load);
    await expect(adapter.list()).rejects.toThrow('chunk');
    expect(await adapter.list()).toMatchObject({ ok: true });
    expect(await settled(Promise.reject(new Error('x')))).toMatchObject({ ok: false, error: { status: 0 } });
  });
});

describe('identity provider views', () => {
  const providers = (): ProviderModel[] => [fromProviderView(VIEW as never), { ...fromProviderView(VIEW as never), id: 'p2', slug: 'adfs', kind: 'saml', enabled: false, oidc: null, saml: { entryPoint: 'https://adfs/ls', idpIssuer: 'http://adfs/trust', idpCertCount: 1, spEntityId: 'x', mfaAuthnContexts: [] } }];

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the providers, the forms, the test result and the policy in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const list = providers();
        rememberTest('p2', { ok: false, issuer: 'http://adfs/trust', endpoints: {}, message: 'The issuer could not be reached', at: '2026-10-28T03:00:00Z' });
        const table = render(<ProvidersTable ctx={ctx} providers={list} busy={null} onTest={() => undefined} onDisable={() => undefined} onEnable={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colName, TEXT.colProtocol, TEXT.colState, TEXT.colTest, TEXT.colActions, TEXT.enabled, TEXT.disabled, TEXT.notTested, TEXT.test, TEXT.disable, TEXT.enable, TEXT.spMetadata]) expect(table, p[0]).toContain(t(p));
        expect(table).toContain('href="/api/v1/auth/saml/adfs/metadata"');
        expect(table).toContain(t(TEXT.testFailedAt).replace(' {at}', ''));
        const adapter = createSampleAdapter();
        const oidc = render(<OidcDrawer ctx={ctx} adapter={adapter} open onClose={() => undefined} onAdded={() => undefined} />, ctx, theme);
        for (const p of [TEXT.oidcTitle, TEXT.buttonLabel, TEXT.slug, TEXT.icon, TEXT.oidcIssuer, TEXT.clientId, TEXT.clientSecret, TEXT.scopes, TEXT.subjectMode, TEXT.mfaTitle, TEXT.requireMfa, TEXT.mfaFallback, TEXT.jit, TEXT.add]) expect(oidc, p[0]).toContain(t(p));
        expect(oidc).toContain('/api/v1/auth/oidc/&lt;id&gt;/callback');
        const saml = render(<SamlDrawer ctx={ctx} adapter={adapter} open onClose={() => undefined} onAdded={() => undefined} />, ctx, theme);
        for (const p of [TEXT.samlTitle, TEXT.metadataXml, TEXT.readMetadata, TEXT.entryPoint, TEXT.idpIssuer, TEXT.idpCerts, TEXT.spEntityId, TEXT.authnContexts, TEXT.samlNoJit]) expect(saml, p[0]).toContain(t(p));
        const result = render(<TestResultDialog ctx={ctx} provider={list[0]} outcome={{ ok: true, issuer: 'https://sso', endpoints: { authorization: 'https://sso/auth', token: 'https://sso/token' }, message: null, at: '2026-10-28T03:00:00Z' }} onClose={() => undefined} />, ctx, theme);
        for (const p of [TEXT.testOk, TEXT.issuer, TEXT.endpoint_authorization, TEXT.endpoint_token]) expect(result, p[0]).toContain(t(p));
        const failed = render(<TestResultDialog ctx={ctx} provider={list[0]} outcome={{ ok: false, issuer: 'https://sso', endpoints: {}, message: 'The issuer could not be reached', at: '2026-10-28T03:00:00Z' }} onClose={() => undefined} />, ctx, theme);
        expect(failed).toContain(`${t(TEXT.testFailed)} The issuer could not be reached`);
        const policy = render(<PolicyCard ctx={ctx} adapter={adapter} providers={list} />, ctx, theme);
        expect(policy).toContain(t(TEXT.policyTitle));
        expect(table + oidc + saml + result + failed + policy).not.toMatch(/[—·]/);
        expect([oidc, saml, result].every((h) => /role="dialog"/.test(h))).toBe(true);
      });
    }
  }

  it('remembers the last test of a provider for the session', () => {
    expect(lastTest('x')).toBeNull();
    expect(testText(ctxOf('en'), null)).toBe('Not tested yet');
    rememberTest('x', { ok: true, issuer: 'i', endpoints: {}, message: null, at: '2026-10-28T03:00:00Z' });
    expect(testText(ctxOf('en'), lastTest('x'))).toMatch(/^Passed 28 Oct 2026/);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the Administration group with idp.manage, under /admin/sign-in, with the two Add actions', () => {
    expect(screen).toMatchObject({ id: 'identity-providers', group: 'admin', scope: 'org', perm: 'idp.manage' });
    expect(screen.path.startsWith('/admin/sign-in/')).toBe(true);
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label[0])).toEqual(['Add OIDC provider', 'Add SAML provider']);
    actions[1].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('identity-providers', { params: { add: 'saml', at: expect.any(Number) } });
  });
});
