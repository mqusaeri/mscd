import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// The Licence screen of the sample build (MILESTONE-2 M2-01): the sample organisation's licence, and the install
// dialog with its checks. @sample-only: the API project covers the screen in e2e/api-only/license.spec.js.
const meta = metaById('license');
const dialog = (page) => ui.modal(page);
const pasteField = (page) => dialog(page).locator('textarea');
const installButton = (page) => dialog(page).locator('button', { hasText: /^(Install licence|Pasang lisensi)$/ });

test.describe('Licence screen @sample-only', () => {
  test('shows the state, dates, seats, systems and what the licence includes', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('Licence');
    await expect(main).toContainText('Administration');
    await expect(main.locator('.mx-badge')).toHaveText(['Valid']);
    for (const text of ['PT Nusantara Digital Teknologi', '31 Mar 2027', '30 days', '86 of 150 active members', 'Guests such as certification auditors are not counted.', '4 of 10', 'ISO/IEC 27001', 'Managed Vault, Microsoft 365, Google Drive', 'Integrated Management System']) {
      await expect(main).toContainText(text);
    }
    await expect(ui.nav(page, 'Licence')).toHaveCSS('font-weight', '600');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('Install licence checks the text before it is sent and installs a licence document', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Install licence').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('role', 'dialog');
    await installButton(page).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose a licence file or paste the licence first.');
    await pasteField(page).fill('{ not json');
    await installButton(page).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('This is not valid JSON. Paste the whole licence file.');
    await expect(pasteField(page)).toHaveAttribute('aria-invalid', 'true');
    await pasteField(page).fill('{"hello": "world"}');
    await installButton(page).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('This document is not a signed licence.');
    await expectOverlayReadable(page);
    const licence = { license_id: 'LIC-SAMPLE-2028', organization: 'PT Nusantara Digital Teknologi', valid_from: '2027-04-01', valid_until: '2028-03-31', grace_days: 45, frameworks: ['ISO27001', 'ISO9001'], max_management_systems: 12, max_users: 200, storage_adapters: ['managed_vault'], features: ['integrated_mode'], key_id: '0a1b2c3d4e5f6789', signature: 'ed25519:sample' };
    await pasteField(page).fill(JSON.stringify(licence));
    await installButton(page).click();
    await expectToast(page, 'Licence installed');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('main')).toContainText('LIC-SAMPLE-2028');
    await expect(page.locator('main')).toContainText('86 of 200 active members');
    await expect(page.locator('main')).toContainText('31 Mar 2028');
  });

  test('a licence file is read into the paste area; Escape and Cancel close the dialog and return the focus', async ({ page }) => {
    await openScreen(page, meta);
    const opener = ui.pageAction(page, 'Install licence');
    await opener.click();
    await dialog(page).locator('input[type="file"]').setInputFiles({ name: 'LIC.json', mimeType: 'application/json', buffer: Buffer.from('{"license_id":"LIC-FILE"}') });
    await expect(pasteField(page)).toHaveValue('{"license_id":"LIC-FILE"}');
    await expect(dialog(page)).toContainText('LIC.json');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(pasteField(page)).toHaveValue('');
    await dialog(page).locator('button', { hasText: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`the dialog is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await ui.pageAction(page, 'Pasang lisensi').click();
      await expect(dialog(page)).toContainText('Berkas lisensi');
      await expect(dialog(page)).toContainText('Pilih berkas');
      await expect(dialog(page)).toContainText('Belum ada berkas dipilih');
      await installButton(page).click();
      await expect(dialog(page).locator('[role="alert"]')).toHaveText('Pilih berkas lisensi atau tempel lisensinya terlebih dahulu.');
      await expectOverlayReadable(page);
    });
  }

  test('Top Management sees the licence without Install licence', async ({ page }) => {
    await page.goto('/?screen=license&persona=top');
    await expect(page.locator('main h1')).toHaveText('Licence');
    await expect(page.locator('header')).toContainText('Top Management');
    await expect(page.locator('main button[title="Install licence"]')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('86 of 150 active members');
  });
});
