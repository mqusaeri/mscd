import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Company sign-in against the api (MILESTONE-2 M2-10, `admin.idp.*`, F.5, F.8, F.9). tenant.admin of the Test
// Organisation adds an OpenID Connect provider against a mock identity provider and tests it (the api runs discovery
// before it saves a provider, and again for Test), sees the refusal of an issuer that does not answer, adds a SAML
// provider from pasted metadata XML, disables and enables a provider, and limits local sign-in to administrators.
// In the dark theme the forms, the test result and the Disable confirmation are readable.
// The mock identity provider is the discovery document of an issuer on 127.0.0.1, served by this spec: the mock
// providers of tools/mock-providers have no OpenID Connect discovery, and the test profile accepts plain-HTTP issuers
// (`identity.oidc.allow_insecure_http`) and, with single tenancy, issuers on the local network.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text }).first();
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);

let server;
let issuer;

/**
 * A self-signed certificate for a SAML provider. The certificate helper is the build output of tools/mock-providers,
 * which only the API stack builds, so it is loaded here at run time: a static import would stop the sample project
 * (which collects this file and skips it) on a fresh checkout.
 */
async function samlCertificate(commonName) {
  const { createSelfSignedCertificate } = await import('../../../../tools/mock-providers/dist/certs.js');
  // The test profile fixes the clock of the api (demo.fixed_today), so the certificate is valid from well before it.
  return createSelfSignedCertificate({ commonName, notBefore: new Date('2026-01-01T00:00:00Z'), days: 3650 });
}

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, {
    method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
  });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const base = issuer;
    if (req.url && /\/\.well-known\/(openid-configuration|oauth-authorization-server)$/.test(req.url.split('?')[0])) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/protocol/openid-connect/auth`,
        token_endpoint: `${base}/protocol/openid-connect/token`,
        userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
        jwks_uri: `${base}/protocol/openid-connect/certs`,
        end_session_endpoint: `${base}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}/realms/e2e`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function metadataXml(certificatePem) {
  const body = certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://adfs.e2e.example/adfs/services/trust">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${body}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://adfs.e2e.example/adfs/ls/"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

test.describe('Company sign-in against the api @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('an OIDC provider against the mock identity provider is added and tested; an issuer that does not answer is refused', async ({ page }) => {
    await openApp(page);
    await go(page, 'Company sign-in');
    await expect(page.locator('main')).toContainText('No company sign-in yet');
    await ui.pageAction(page, 'Add OIDC provider').click();
    await field(page, 'displayName').fill('Sign in with E2E IdP');
    await expect(field(page, 'slug')).toHaveValue('e2e-idp');
    await expect(drawer(page)).toContainText('/api/v1/auth/oidc/e2e-idp/callback');
    await field(page, 'issuer').fill('http://127.0.0.1:9/realms/none');
    await field(page, 'clientId').fill('mscd');
    await field(page, 'clientSecret').fill('e2e-client-secret');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expect(drawer(page)).toContainText('OpenID Connect discovery failed');
    await field(page, 'issuer').fill(issuer);
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expectToast(page, 'Sign in with E2E IdP added. Test it before people use it.');
    await expect(drawer(page)).toHaveCount(0);
    const provider = row(page, 'Sign in with E2E IdP');
    await expect(provider).toContainText('OpenID Connect');
    await expect(provider).toContainText('Enabled');
    await expect(provider).toContainText('Not tested yet');

    await provider.locator('button', { hasText: 'Test' }).click();
    await expect(dialog(page)).toContainText('The provider answered. These endpoints were found:');
    await expect(dialog(page)).toContainText(`${issuer}/protocol/openid-connect/auth`);
    await expect(dialog(page)).toContainText('Signing keys');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(provider).toContainText(/Passed \d{2} \w+ \d{4}/);

    await provider.locator('button', { hasText: 'Disable' }).click();
    await expect(dialog(page)).toContainText('every session signed in through it ends now');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Disable$/ }).click();
    await expectToast(page, 'Sign in with E2E IdP is disabled');
    await expect(provider).toContainText('Disabled');
    await provider.locator('button', { hasText: 'Enable' }).click();
    await expectToast(page, 'Sign in with E2E IdP is enabled');
    await expect(provider).toContainText('Enabled');
  });

  test('a SAML provider is added from pasted metadata XML and shows its service provider metadata', async ({ page, baseURL }) => {
    const certificate = await samlCertificate('mscd-e2e-m2-10-saml');
    await openApp(page);
    await go(page, 'Company sign-in');
    await ui.pageAction(page, 'Add SAML provider').click();
    await field(page, 'displayName').fill('Sign in with AD FS');
    await expect(field(page, 'slug')).toHaveValue('ad-fs');
    await field(page, 'metadataXml').fill(metadataXml(certificate.certificatePem));
    await drawer(page).locator('button', { hasText: 'Fill from metadata' }).click();
    await expect(field(page, 'entryPoint')).toHaveValue('https://adfs.e2e.example/adfs/ls/');
    await expect(field(page, 'idpIssuer')).toHaveValue('http://adfs.e2e.example/adfs/services/trust');
    await field(page, 'mfaAuthnContexts').fill('http://schemas.microsoft.com/claims/multipleauthn');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expectToast(page, 'Sign in with AD FS added');
    const provider = row(page, 'Sign in with AD FS');
    await expect(provider).toContainText('SAML 2.0');
    const link = provider.locator('a', { hasText: 'Service provider metadata' });
    await expect(link).toHaveAttribute('href', '/api/v1/auth/saml/ad-fs/metadata');
    const metadata = await page.request.get(`${baseURL}/api/v1/auth/saml/ad-fs/metadata`);
    expect(metadata.ok()).toBe(true);
    expect(await metadata.text()).toContain('EntityDescriptor');
    await provider.locator('button', { hasText: 'Test' }).click();
    await expect(dialog(page)).toContainText('The provider answered.');
    await expect(dialog(page)).toContainText('https://adfs.e2e.example/adfs/ls/');
    await expect(dialog(page)).toContainText('Service provider metadata');
  });

  test('in the dark theme the forms, the test result and the Disable confirmation are readable', async ({ page, baseURL }) => {
    test.slow();
    const certificate = await samlCertificate('mscd-e2e-m2-10-dark');
    await apiWrite(page, baseURL, 'POST', '/api/v1/admin/identity-providers', {
      slug: 'ad-fs', kind: 'saml', displayName: 'Sign in with AD FS', icon: 'generic',
      saml: {
        entryPoint: 'https://adfs.e2e.example/adfs/ls/', idpIssuer: 'http://adfs.e2e.example/adfs/services/trust', idpCerts: [certificate.certificatePem],
        spEntityId: `${baseURL}/api/v1/auth/saml/ad-fs/metadata`, mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'],
      },
      requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [],
    });
    await openApp(page);
    await darkTheme(page);
    await go(page, 'Company sign-in');
    await expect(row(page, 'Sign in with AD FS')).toContainText('Enabled');
    await expectReadableText(page, 4.5);

    await ui.pageAction(page, 'Add OIDC provider').click();
    await field(page, 'displayName').fill('Sign in with E2E IdP');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Cancel$/ }).click();
    await expect(drawer(page)).toHaveCount(0);
    await ui.pageAction(page, 'Add SAML provider').click();
    await field(page, 'metadataXml').fill(metadataXml(certificate.certificatePem));
    await drawer(page).locator('button', { hasText: 'Fill from metadata' }).click();
    await expect(field(page, 'entryPoint')).toHaveValue('https://adfs.e2e.example/adfs/ls/');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Cancel$/ }).click();
    await expect(drawer(page)).toHaveCount(0);

    const provider = row(page, 'Sign in with AD FS');
    await provider.locator('button', { hasText: 'Test' }).click();
    await expect(dialog(page)).toContainText('The provider answered.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await provider.locator('button', { hasText: 'Disable' }).click();
    await expect(dialog(page)).toContainText('every session signed in through it ends now');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Disable$/ }).click();
    await expectToast(page, 'Sign in with AD FS is disabled');
    await expect(provider).toContainText('Disabled');

    const policy = page.locator('main section', { hasText: 'Local sign-in' });
    await policy.getByLabel('Administrators only (Tenant Admins and Storage Admins)').check();
    await expect(policy).toContainText('Test company sign-in first.');
    await expectReadableText(page, 4.5);
  });

  test('local sign-in is limited to administrators after the warning to test company sign-in first', async ({ page }) => {
    await openApp(page);
    await go(page, 'Company sign-in');
    const policy = page.locator('main section', { hasText: 'Local sign-in' });
    await expect(policy.getByLabel('Everyone')).toBeChecked();
    await policy.getByLabel('Administrators only (Tenant Admins and Storage Admins)').check();
    await expect(policy).toContainText('Test company sign-in first.');
    await policy.locator('button', { hasText: 'Save policy' }).click();
    await expectToast(page, 'Local sign-in policy saved');
    await openApp(page);
    await go(page, 'Company sign-in');
    await expect(page.locator('main section', { hasText: 'Local sign-in' }).getByLabel('Administrators only (Tenant Admins and Storage Admins)')).toBeChecked();
    await page.locator('main section', { hasText: 'Local sign-in' }).getByLabel('Everyone').check();
    await page.locator('main section', { hasText: 'Local sign-in' }).locator('button', { hasText: 'Save policy' }).click();
    await expectToast(page, 'Local sign-in policy saved');
  });
});
