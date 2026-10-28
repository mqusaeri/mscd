import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// Company sign-in of the sample build (MILESTONE-2 M2-10): the sample organisation signs in with Microsoft Entra ID
// (OIDC) and keeps a disabled AD FS provider (SAML). "Test", "Add OIDC provider" with its checks, "Add SAML provider"
// filled from pasted metadata XML, "Disable" with the sessions warning, and the local sign-in policy with the warning
// to test company sign-in first. @sample-only: the API project covers the screen in
// e2e/api-only/identity-providers.spec.js.
const meta = metaById('identity-providers');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text }).first();
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);

const CERT = 'MIIC8DCCAdigAwIBAgIQSampleSigningCertificateForTheSampleBuildOnlyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const METADATA = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sso.nusa.example/saml">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${CERT}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://sso.nusa.example/saml/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

test.describe('Company sign-in @sample-only', () => {
  test('lists the providers and tests one: the endpoints found, and the last test in the list', async ({ page }) => {
    await openScreen(page, meta);
    await expect(rows(page)).toHaveCount(2);
    await expect(row(page, 'Sign in with Microsoft')).toContainText('OpenID Connect');
    await expect(row(page, 'Sign in with Microsoft')).toContainText('Accounts created at first sign-in for nusantaradigital.co.id');
    await expect(row(page, 'Sign in with AD FS')).toContainText('Disabled');
    await expect(row(page, 'Sign in with AD FS').locator('a', { hasText: 'Service provider metadata' })).toHaveAttribute('href', '/api/v1/auth/saml/adfs/metadata');
    await expect(row(page, 'Sign in with Microsoft')).toContainText('Not tested yet');
    await row(page, 'Sign in with Microsoft').locator('button', { hasText: 'Test' }).click();
    await expect(dialog(page)).toContainText('Test of Sign in with Microsoft');
    await expect(dialog(page)).toContainText('The provider answered. These endpoints were found:');
    await expect(dialog(page)).toContainText('Sign-in page');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(row(page, 'Sign in with Microsoft')).toContainText(/Passed \d{2} \w+ \d{4}/);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('Add OIDC provider checks the fields, then adds a provider whose test fails when its issuer does not answer', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Add OIDC provider').click();
    await expect(drawer(page)).toContainText('Add an OpenID Connect provider');
    await expect(drawer(page)).toContainText('/api/v1/auth/oidc/<id>/callback');
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expect(drawer(page).locator('[role="alert"]').first()).toBeVisible();
    await field(page, 'displayName').fill('Sign in with Keycloak');
    await expect(field(page, 'slug')).toHaveValue('keycloak');
    await expect(drawer(page)).toContainText('/api/v1/auth/oidc/keycloak/callback');
    await field(page, 'issuer').fill('ftp://sso');
    await field(page, 'clientId').fill('mscd');
    await field(page, 'clientSecret').fill('a-client-secret');
    await field(page, 'jitProvisioning').check();
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expect(drawer(page)).toContainText('Enter an address that starts with https://');
    await expect(drawer(page)).toContainText('Name at least one verified email domain.');
    await field(page, 'issuer').fill('https://sso.keycloak.invalid/realms/mscd');
    await field(page, 'domains').fill('nusantaradigital.co.id');
    await field(page, 'requireMfaClaim').uncheck();
    await drawer(page).getByLabel('Refuse the sign-in').check();
    await expect(drawer(page)).toContainText('Refusing the sign-in needs the second factor of the provider');
    await drawer(page).getByLabel('Ask for the MSCD authenticator code').check();
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expectToast(page, 'Sign in with Keycloak added. Test it before people use it.');
    await row(page, 'Sign in with Keycloak').locator('button', { hasText: 'Test' }).click();
    await expect(dialog(page)).toContainText('The test failed. The issuer could not be reached');
    await page.keyboard.press('Escape');
    await expect(row(page, 'Sign in with Keycloak')).toContainText('Failed');
  });

  test('Add SAML provider reads the pasted metadata XML into the fields', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Add SAML provider').click();
    await expect(drawer(page)).toContainText('Add a SAML provider');
    await field(page, 'displayName').fill('Sign in with Nusa SSO');
    await expect(field(page, 'slug')).toHaveValue('nusa-sso');
    await expect(field(page, 'spEntityId')).toHaveValue(/\/api\/v1\/auth\/saml\/nusa-sso\/metadata$/);
    await field(page, 'metadataXml').fill('<html>not metadata</html>');
    await drawer(page).locator('button', { hasText: 'Fill from metadata' }).click();
    await expect(drawer(page)).toContainText('This is not SAML metadata of an identity provider');
    await field(page, 'metadataXml').fill(METADATA);
    await drawer(page).locator('button', { hasText: 'Fill from metadata' }).click();
    await expect(drawer(page)).toContainText('Filled from the metadata: Identity provider entity id, Sign-on address (entry point), Signing certificates.');
    await expect(field(page, 'entryPoint')).toHaveValue('https://sso.nusa.example/saml/sso');
    await expect(field(page, 'idpIssuer')).toHaveValue('https://sso.nusa.example/saml');
    await expect(field(page, 'idpCerts')).toHaveValue(/^-----BEGIN CERTIFICATE-----\nMIIC8DCC/);
    await expect(drawer(page)).toContainText('accounts are not created at first sign-in');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Add provider' }).click();
    await expectToast(page, 'Sign in with Nusa SSO added');
    await expect(row(page, 'Sign in with Nusa SSO')).toContainText('SAML 2.0');
    await expect(row(page, 'Sign in with Nusa SSO').locator('a', { hasText: 'Service provider metadata' })).toHaveAttribute('href', '/api/v1/auth/saml/nusa-sso/metadata');
  });

  test('Disable warns that its sessions end; local sign-in warns to test company sign-in first', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'Sign in with Microsoft').locator('button', { hasText: 'Disable' }).click();
    await expect(dialog(page)).toContainText('every session signed in through it ends now');
    await expect(dialog(page)).toContainText('This is the only enabled company sign-in.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Disable$/ }).click();
    await expectToast(page, 'Sign in with Microsoft is disabled');
    await expect(row(page, 'Sign in with Microsoft')).toContainText('Disabled');
    await row(page, 'Sign in with Microsoft').locator('button', { hasText: 'Enable' }).click();
    await expectToast(page, 'Sign in with Microsoft is enabled');

    const policy = page.locator('main section', { hasText: 'Local sign-in' });
    await policy.locator('button', { hasText: 'Save policy' }).click();
    await expect(policy).toContainText('Nothing was changed.');
    await policy.getByLabel('Administrators only (Tenant Admins and Storage Admins)').check();
    await expect(policy).toContainText('Test company sign-in first.');
    await expect(policy).toContainText('No company sign-in provider is enabled and tested yet.');
    await policy.getByLabel('Nobody: company sign-in only').check();
    await expect(policy).toContainText('Keep at least administrators allowed');
    await expectReadableText(page, 4.5);
    await policy.getByLabel('Administrators only (Tenant Admins and Storage Admins)').check();
    await policy.locator('button', { hasText: 'Save policy' }).click();
    await expectToast(page, 'Local sign-in policy saved');
  });

  for (const theme of ['light', 'dark']) {
    test(`the forms are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(row(page, 'Sign in with AD FS')).toContainText('Nonaktif');
      await expectReadableText(page, 4.5);
      await ui.pageAction(page, 'Tambah penyedia OIDC').click();
      await expect(drawer(page)).toContainText('Tambah penyedia OpenID Connect');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await ui.pageAction(page, 'Tambah penyedia SAML').click();
      await expect(drawer(page)).toContainText('Tambah penyedia SAML');
      await expectOverlayReadable(page);
    });
  }
});
