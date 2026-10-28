import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';
import { stackState } from '../../e2e-api/fixtures.js';

// Repository administration against the api (MILESTONE-2 M2-09): "Connect repository" and "Settings" of the Storage
// repositories screen open the wizard and the settings drawer (claims storage.connect and storage.settings). The
// wizard connects a SharePoint library of the mock providers: POST the repository, PUT its certificate credential
// (sealed by the storage gateway), then test the connection through the gateway against the mock Graph API.
const TENANT = '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const CLIENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const drawer = (page) => ui.drawer(page);
const button = (page, label) => drawer(page).locator('button', { hasText: new RegExp(`^${label}$`) });
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);
const cards = (page) => page.locator('main div[style*="box-shadow"][style*="flex-direction: column"][style*="gap: 10px"]');
const card = (page, name) => cards(page).filter({ has: page.locator('div', { hasText: new RegExp(`^${name}$`) }) });

/**
 * Registers an app certificate for the demo SharePoint tenant at the mock identity platform. The certificate helper
 * is the build output of tools/mock-providers, which only the API stack builds, so it is loaded here at run time: a
 * static import would stop the sample project (which collects this file and skips it) on a fresh checkout.
 */
async function registerApp() {
  const { createSelfSignedCertificate } = await import('../../../../tools/mock-providers/dist/certs.js');
  const certificate = createSelfSignedCertificate({ commonName: 'mscd-e2e-m2-09', days: 30 });
  const res = await fetch(`${stackState().mock}/_admin/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'm365_certificate', tenantId: TENANT, clientId: CLIENT, certificatePem: certificate.certificatePem, displayName: 'MSCD E2E' }),
  });
  expect(res.ok, await res.text()).toBe(true);
  return certificate;
}

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

test.describe('Repository administration against the api @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('Connect repository connects a SharePoint library of the mock provider and tests it', async ({ page }) => {
    const certificate = await registerApp();
    await openApp(page);
    await go(page, 'Storage repositories');
    await ui.pageAction(page, 'Connect repository').click();
    await expect(drawer(page)).toContainText('Step 1: Storage type');
    await expect(drawer(page)).toContainText('The storage types your licence includes.');
    await drawer(page).getByLabel('Microsoft 365 (SharePoint or OneDrive)').check();
    await expectOverlayReadable(page);
    await button(page, 'Next').click();

    await field(page, 'name').fill('SharePoint Quality');
    await expect(field(page, 'slug')).toHaveValue('sharepoint-quality');
    await field(page, 'tenantId').fill(TENANT);
    await field(page, 'siteId').fill('nusantaradigital.sharepoint.com,compliance');
    await field(page, 'driveId').fill('drive-sp-compliance');
    await field(page, 'rootFolderId').fill('demo-sp-compliance');
    await field(page, 'root-isms-id').fill('demo-sp-isms');
    await field(page, 'root-isms-path').fill('Compliance/ISMS');
    await drawer(page).getByLabel('Pass-through').check();
    await drawer(page).getByLabel(/^The retention settings/).check();
    await expectOverlayReadable(page);
    await button(page, 'Save and continue').click();
    await expectToast(page, 'Repository SharePoint Quality saved');
    await expect(drawer(page)).toContainText('Step 3 of 4: Credential');

    await expect(field(page, 'credential-tenantId')).toHaveValue(TENANT);
    await field(page, 'credential-clientId').fill(CLIENT);
    await field(page, 'credential-certificate').fill(certificate.certificatePem);
    await field(page, 'credential-privateKey').fill(certificate.privateKeyPem);
    await expectOverlayReadable(page);
    await button(page, 'Save credential').click();
    await expectToast(page, 'Credential saved and sealed');
    await expect(drawer(page)).toContainText('Step 4 of 4: Test connection');

    await button(page, 'Test connection').click();
    const result = drawer(page).locator('[role="status"]').filter({ hasText: 'Connected to' });
    await expect(result).toContainText('Connected to Compliance');
    await expect(drawer(page)).toContainText('Next automatic check');
    await expectOverlayReadable(page);
    await button(page, 'Done').click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(card(page, 'SharePoint Quality')).toContainText('Connected');
    await expect(card(page, 'SharePoint Quality')).toContainText('Site nusantaradigital.sharepoint.com,compliance, library drive-sp-compliance');
  });

  test('the wizard shows the server refusal of a short id in use and keeps the form open; the steps read well in dark', async ({ page }) => {
    const certificate = await registerApp();
    await openApp(page);
    await go(page, 'Storage repositories');
    await darkTheme(page);
    await ui.pageAction(page, 'Connect repository').click();
    await drawer(page).getByLabel('Microsoft 365 (SharePoint or OneDrive)').check();
    await button(page, 'Next').click();
    await field(page, 'name').fill('SharePoint Online');
    await field(page, 'slug').fill('sp');
    await field(page, 'siteId').fill('nusantaradigital.sharepoint.com,compliance');
    await field(page, 'driveId').fill('drive-sp-compliance');
    await field(page, 'rootFolderId').fill('demo-sp-compliance');
    await button(page, 'Save and continue').click();
    // The short id of the seeded SharePoint repository is taken: the server's conflict shows at the field.
    await expect(field(page, 'slug')).toHaveAttribute('aria-invalid', 'true');
    await expect(drawer(page)).toContainText('A repository with the slug sp exists');
    await expect(drawer(page)).toContainText('Step 2 of 4: Settings');
    await expectOverlayReadable(page);

    // A free short id, then the credential and test steps in the dark theme (test 1 checks them in light).
    await field(page, 'name').fill('SharePoint Quality');
    await field(page, 'slug').fill('sp-quality');
    await field(page, 'tenantId').fill(TENANT);
    await button(page, 'Save and continue').click();
    await expectToast(page, 'Repository SharePoint Quality saved');
    await expect(drawer(page)).toContainText('Step 3 of 4: Credential');
    await field(page, 'credential-clientId').fill(CLIENT);
    await field(page, 'credential-certificate').fill(certificate.certificatePem);
    await field(page, 'credential-privateKey').fill(certificate.privateKeyPem);
    await expectOverlayReadable(page);
    await button(page, 'Save credential').click();
    await expectToast(page, 'Credential saved and sealed');
    await expect(drawer(page)).toContainText('Step 4 of 4: Test connection');
    await button(page, 'Test connection').click();
    await expect(drawer(page).locator('[role="status"]').filter({ hasText: 'Connected to' })).toContainText('Connected to Compliance');
    await expectOverlayReadable(page);
    await button(page, 'Done').click();
    await expect(drawer(page)).toHaveCount(0);
  });

  test('Settings of a card changes the repository; a folder change asks for the credential again', async ({ page }) => {
    await openApp(page);
    await go(page, 'Storage repositories');
    await card(page, 'SharePoint Online').locator('button[title="Settings"]').click();
    await expect(drawer(page)).toContainText('SharePoint Online');
    await expect(drawer(page)).toContainText('A credential is set');
    await expect(field(page, 'rootFolderId')).not.toHaveValue('');
    await expectOverlayReadable(page);
    await field(page, 'name').fill('SharePoint Compliance');
    await button(page, 'Save').click();
    await expectToast(page, 'Settings of SharePoint Compliance saved');
    await field(page, 'rootFolderId').fill('demo-sp-isms');
    await button(page, 'Save').click();
    await expect(drawer(page)).toContainText('The settings changed, so the credential was removed. Set it again, then test the connection.');
    await expect(drawer(page)).toContainText('No credential is set.');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await darkTheme(page);
    await card(page, 'SharePoint Compliance').locator('button[title="Settings"]').click();
    await expect(drawer(page)).toContainText('SharePoint Compliance');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Open repository administration' }).click();
    await expect(ui.title(page)).toHaveText('Repository administration');
    const row = page.locator('main table tbody tr').filter({ hasText: 'SharePoint Compliance' });
    await expect(row).toContainText('Not set');
    await expect(row).toContainText('Not connected');
    await ui.pageAction(page, 'Connect repository').click();
    await expect(drawer(page)).toContainText('Step 1: Storage type');
    await expectOverlayReadable(page);
  });
});
