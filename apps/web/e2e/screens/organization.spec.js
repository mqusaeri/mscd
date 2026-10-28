import { test, expect, ui, go, openScreen, metaById, expectToast, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// Organisation of the sample build (MILESTONE-2 M2-16): the settings of the sample organisation (PT Nusantara Digital
// Teknologi, a service with several organisations), the permanent slug and the installation id with Copy. A saved
// change stays for the page session. @sample-only: the API project covers the screen in e2e/api-only/organization.spec.js.
const meta = metaById('organization');
const SAMPLE_ID = '5a3e1c9d-7b2f-4c8e-9a1d-3f6b2e8c4d01';
const form = (page) => page.locator('main section').filter({ has: page.locator('form') });
const nameField = (page) => form(page).locator('input').first();
const sites = (page) => form(page).locator('input[type="number"]');
const zone = (page) => form(page).locator('select');
const save = (page, label = 'Save changes') => form(page).locator('button', { hasText: label });

test.describe('Organisation @sample-only', () => {
  test('shows the settings, the permanent slug and the installation id, saves a change and keeps it', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('Organisation');
    await expect(form(page)).toContainText('Organisation settings');
    await expect(nameField(page)).toHaveValue('PT Nusantara Digital Teknologi');
    await expect(zone(page)).toHaveValue('Asia/Jakarta');
    await expect(sites(page)).toHaveValue('2');
    await expect(form(page).locator('input[disabled]')).toHaveValue('ndt (cannot be changed)');
    await expect(main.locator('[data-installation-id]')).toHaveAttribute('data-installation-id', SAMPLE_ID);
    await expect(main).toContainText('Licences of this service are installed by your MSCD service provider.');
    await expect(main).toContainText('Service with several organisations');
    await expect(main).toContainText('Active administrators');
    await sites(page).fill('4');
    await zone(page).selectOption('Asia/Makassar');
    await save(page).click();
    await expectToast(page, 'Organisation settings saved');
    await expect(sites(page)).toHaveValue('4');
    await expect(zone(page)).toHaveValue('Asia/Makassar');
    // The saved values are what the form compares with now: nothing changed, nothing is sent.
    await save(page).click();
    await expect(form(page).locator('[role="status"]')).toHaveText('Nothing changed.');
    // Another screen and back: the page session keeps the change.
    await go(page, 'Licence');
    await go(page, 'Organisation');
    await expect(sites(page)).toHaveValue('4');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('checks the name and the number of sites before anything is saved', async ({ page }) => {
    await openScreen(page, meta);
    await nameField(page).fill(' ');
    await sites(page).fill('10001');
    await save(page).click();
    await expect(form(page).locator('[role="alert"]')).toHaveText(['Enter the name of the organisation.', 'Enter a whole number from 0 to 10,000.']);
    await expect(ui.toast(page)).toHaveCount(0);
    // Editing a field clears its message; a whole number in range passes.
    await sites(page).fill('3');
    await expect(form(page).locator('[role="alert"]')).toHaveText(['Enter the name of the organisation.']);
    await nameField(page).fill('PT Nusantara Digital Teknologi Tbk');
    await save(page).click();
    await expectToast(page, 'Organisation settings saved');
    await expect(nameField(page)).toHaveValue('PT Nusantara Digital Teknologi Tbk');
    await expect(sites(page)).toHaveValue('3');
  });

  test('Copy puts the installation id on the clipboard; the Licence screen shows the same id', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openScreen(page, meta);
    await page.locator('main section', { hasText: 'Installation id' }).locator('button', { hasText: 'Copy' }).click();
    await expectToast(page, 'Installation id copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SAMPLE_ID);
    await go(page, 'Licence');
    await expect(page.locator('main [data-installation-id]')).toHaveAttribute('data-installation-id', SAMPLE_ID);
    // Both screens say the same about who installs licences of the sample organisation (a SaaS service).
    const panel = page.locator('main section', { hasText: 'Installation id' });
    await expect(panel).toContainText('Licences of this service are installed by your MSCD service provider.');
    await expect(panel).not.toContainText('Send this id with a licence request');
  });

  for (const theme of ['light', 'dark']) {
    test(`is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      const main = page.locator('main');
      await expect(main.locator('h1')).toHaveText('Organisasi');
      await expect(form(page)).toContainText('Pengaturan organisasi');
      await expect(form(page).locator('input[disabled]')).toHaveValue('ndt (tidak dapat diubah)');
      await expect(main).toContainText('ID instalasi');
      await expect(main).toContainText('Layanan dengan beberapa organisasi');
      await expect(page.locator('main section', { hasText: 'ID instalasi' }).locator('button', { hasText: 'Salin' })).toBeVisible();
      await save(page, 'Simpan perubahan').click();
      await expect(form(page).locator('[role="status"]')).toHaveText('Tidak ada yang berubah.');
      await nameField(page).fill('');
      await save(page, 'Simpan perubahan').click();
      await expect(form(page).locator('[role="alert"]')).toHaveText('Masukkan nama organisasi.');
      await expectReadableText(page, 4.5);
    });
  }
});
