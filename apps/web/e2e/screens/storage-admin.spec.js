import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Repository administration of the sample build (MILESTONE-2 M2-09): the screen without a sidebar entry (opened with
// ?screen=storage-admin), the "Connect repository" wizard for each storage type, and the settings drawer. Changes
// stay in the browser session. @sample-only: the API project covers the claims of the Storage repositories screen
// and the wizard against the mock providers in e2e/api-only/storage-admin.spec.js.
const meta = metaById('storage-admin');
const drawer = (page) => ui.drawer(page);
const button = (page, label) => drawer(page).locator('button', { hasText: new RegExp(`^${label}$`) });
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text });
const CERT = '-----BEGIN CERTIFICATE-----\nMIIC7DCCAdSgAwIBAgIQ\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

test.describe('Repository administration @sample-only', () => {
  test('lists the repositories with storage type, modes, connection and credential', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('Repository administration');
    await expect(main).toContainText('Administration');
    await expect(ui.nav(page, 'Repository administration')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, 'SharePoint Online')).toContainText('Microsoft 365');
    await expect(row(page, 'SharePoint Online')).toContainText('Link, Pass-through');
    await expect(row(page, 'SharePoint Online')).toContainText('Expires 30 Jun 2027');
    await expect(row(page, 'Google Shared Drive')).toContainText('Access revoked');
    await expect(row(page, 'Managed Vault')).toContainText('Not needed');
    await expect(row(page, 'OneDrive personal')).toContainText('Personal (one account)');
    await expect(main).toContainText('Sample build: changes stay in this browser session and no provider is called.');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('connects a SharePoint library in four steps: type, settings with id checks, credential, test', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Connect repository').click();
    await expect(drawer(page)).toHaveAttribute('role', 'dialog');
    // The first step shows no total, so the count does not change when another storage type is chosen.
    await expect(drawer(page)).toContainText('Step 1: Storage type');
    await drawer(page).getByLabel('Microsoft 365 (SharePoint or OneDrive)').check();
    await expect(drawer(page)).toContainText('Step 1: Storage type');
    await expect(drawer(page)).not.toContainText('Step 1 of');
    await expectOverlayReadable(page);
    await button(page, 'Next').click();
    await expect(drawer(page)).toContainText('Step 2 of 4: Settings');

    await button(page, 'Save and continue').click();
    for (const name of ['name', 'slug', 'siteId', 'driveId', 'rootFolderId']) await expect(field(page, name)).toHaveAttribute('aria-invalid', 'true');
    await expectOverlayReadable(page);
    await field(page, 'name').fill('SharePoint Quality');
    await expect(field(page, 'slug')).toHaveValue('sharepoint-quality');
    await field(page, 'slug').fill('SP 2');
    await field(page, 'tenantId').fill('not-a-tenant');
    await field(page, 'siteId').fill('nusantaradigital.sharepoint.com,quality');
    await field(page, 'driveId').fill('drive/quality');
    await field(page, 'rootFolderId').fill('root-quality');
    await field(page, 'root-qms-id').fill('folder-qms');
    await button(page, 'Save and continue').click();
    await expect(drawer(page)).toContainText('Use 2 to 20 lower case letters, digits or hyphens, starting with a letter.');
    await expect(drawer(page)).toContainText('Enter the id in the form 6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b.');
    await expect(drawer(page)).toContainText('Only letters, digits, !, _ and - are allowed.');
    await expect(drawer(page)).toContainText('Give both the folder id and the path, or neither.');
    await field(page, 'slug').fill('sp-quality');
    await field(page, 'tenantId').fill('6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b');
    await field(page, 'driveId').fill('drive-sp-quality');
    await field(page, 'root-qms-path').fill('Compliance/QMS');
    await drawer(page).getByLabel('Pass-through').check();
    await drawer(page).getByLabel(/^The retention settings/).check();
    await button(page, 'Save and continue').click();
    await expectToast(page, 'Repository SharePoint Quality saved');
    await expect(drawer(page)).toContainText('Step 3 of 4: Credential');
    await expect(drawer(page)).toContainText('No credential is set.');

    await expect(field(page, 'credential-tenantId')).toHaveValue('6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b');
    await button(page, 'Save credential').click();
    await expect(field(page, 'credential-clientId')).toHaveAttribute('aria-invalid', 'true');
    await expect(drawer(page)).toContainText('Paste the whole certificate, including -----BEGIN CERTIFICATE-----.');
    await expectOverlayReadable(page);
    await field(page, 'credential-clientId').fill('2f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f');
    await field(page, 'credential-certificate').fill(CERT);
    await field(page, 'credential-privateKey').fill(KEY);
    await button(page, 'Save credential').click();
    await expectToast(page, 'Credential saved and sealed');
    await expect(drawer(page)).toContainText('Step 4 of 4: Test connection');

    await button(page, 'Test connection').click();
    await expect(drawer(page).locator('[role="status"]').filter({ hasText: 'Connected' })).toContainText('Connected to SharePoint Quality, Compliance/QMS');
    await expect(drawer(page)).toContainText('Sites.Selected: read, Sites.Selected: write');
    await expectOverlayReadable(page);
    await button(page, 'Done').click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(row(page, 'SharePoint Quality')).toContainText('Connected');
    await expect(row(page, 'SharePoint Quality')).toContainText('Expires');
    await expect(row(page, 'SharePoint Quality')).toContainText('Site nusantaradigital.sharepoint.com,quality, library drive-sp-quality');
  });

  test('a My Drive is allowed and marked personal; delegated consent needs the OAuth client', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Connect repository').click();
    await drawer(page).getByLabel('Google Drive (shared drive or My Drive)').check();
    await button(page, 'Next').click();
    await drawer(page).getByLabel('My Drive of one account').check();
    await expect(drawer(page)).toContainText('A My Drive is allowed, but it ties company records to one person.');
    await expect(field(page, 'driveId')).toHaveCount(0);
    await field(page, 'name').fill('Tono My Drive');
    await field(page, 'rootFolderId').fill('my-root-folder');
    await field(page, 'oauthClientId').fill('mscd-demo-bcms.apps.googleusercontent.com');
    await expectOverlayReadable(page);
    await button(page, 'Save and continue').click();
    await expectToast(page, 'Repository Tono My Drive saved');
    await drawer(page).getByLabel('A Google account grants access (delegated consent)').check();
    await expect(drawer(page)).toContainText('mscd-demo-bcms.apps.googleusercontent.com');
    await field(page, 'credential-clientSecret').fill('s3cret');
    await button(page, 'Save credential').click();
    await expectToast(page, 'Credential saved and sealed');
    await expect(field(page, 'credential-clientSecret')).toHaveValue('');
    await button(page, 'Grant consent').click();
    await expectToast(page, 'Sample build: no consent page opens');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await expect(row(page, 'Tono My Drive')).toContainText('Personal (one account)');
    await expect(row(page, 'Tono My Drive')).toContainText('My Drive, root folder my-root-folder');
  });

  test('a Managed Vault gets its prefix from the organisation and needs no credential', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Connect repository').click();
    await button(page, 'Next').click();
    await field(page, 'name').fill('Restricted vault');
    await expect(drawer(page)).toContainText('tenants/ndt/restricted-vault/');
    await button(page, 'Save and continue').click();
    await expect(drawer(page)).toContainText('Step 3 of 3: Test connection');
    await button(page, 'Test connection').click();
    await expect(drawer(page)).toContainText('Connected to Restricted vault');
    await button(page, 'Done').click();
    await expect(row(page, 'Restricted vault')).toContainText('Not needed');
  });

  test('Settings changes a repository with PATCH; a folder change asks for the credential again', async ({ page }) => {
    await openScreen(page, meta);
    // SharePoint Online is the first repository; the row keeps its place when the name changes.
    const opener = rows(page).first().locator('button', { hasText: 'Settings' });
    await expect(rows(page).first()).toContainText('SharePoint Online');
    await opener.click();
    await expect(drawer(page)).toContainText('SharePoint Online');
    await expect(drawer(page)).toContainText('Changing the site, library, drive or folders needs the credential to be set again');
    await expect(field(page, 'slug')).toHaveCount(0);
    await expect(field(page, 'rootFolderId')).toHaveValue('demo-sp-compliance');
    await expectOverlayReadable(page);
    await button(page, 'Save').click();
    await expect(drawer(page)).toContainText('Nothing changed.');
    await field(page, 'name').fill('SharePoint Compliance');
    await button(page, 'Save').click();
    await expectToast(page, 'Settings of SharePoint Compliance saved');
    await field(page, 'root-isms-path').fill('Compliance/ISMS-2026');
    await button(page, 'Save').click();
    await expect(drawer(page)).toContainText('The settings changed, so the credential was removed. Set it again, then test the connection.');
    await expect(drawer(page)).toContainText('No credential is set.');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(row(page, 'SharePoint Compliance')).toContainText('Not set');
  });

  for (const theme of ['light', 'dark']) {
    test(`the wizard and the settings drawer are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await ui.pageAction(page, 'Hubungkan repositori').click();
      await expect(drawer(page)).toContainText('Langkah 1: Jenis penyimpanan');
      await drawer(page).getByLabel('Google Drive (shared drive atau My Drive)').check();
      await button(page, 'Lanjut').click();
      await button(page, 'Simpan dan lanjutkan').click();
      await expect(drawer(page)).toContainText('Isi kolom ini.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await row(page, 'Google Shared Drive').locator('button', { hasText: 'Pengaturan' }).click();
      await expect(drawer(page)).toContainText('Akses dicabut');
      await expectOverlayReadable(page);
    });
  }
});
