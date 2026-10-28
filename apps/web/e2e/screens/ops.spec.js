import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow } from '../helpers.js';

// The operator console of the sample build (MILESTONE-2 M2-16), as a multi tenancy service: health, jobs,
// organisations with Create and Install licence, framework packs with Install pack, and the factor reset.
// @sample-only: the API project covers the console of a single tenancy installation in e2e/api-only/ops.spec.js.
const meta = metaById('ops');
const dialog = (page) => ui.modal(page);
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });

test.describe('Operator console @sample-only', () => {
  test('Health shows the components, migrations and licence states', async ({ page }) => {
    await openScreen(page, meta);
    await expect(ui.title(page)).toHaveText('Operator console');
    await expect(page.locator('aside nav')).toContainText('Operator console');
    const main = page.locator('main');
    for (const text of ['database', 'storage-gateway', '0008_milestone2', 'Up to date', 'Grace period', 'Download diagnostics']) await expect(main).toContainText(text);
    await main.locator('button', { hasText: 'Download diagnostics' }).click();
    await expect(main).toContainText('The sample build has no server to read diagnostics from.');
    await expectNoHorizontalOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('Jobs shows the queues and runs a job of the allow-list', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Jobs').click();
    const main = page.locator('main');
    await expect(main).toContainText('freshness.recompute');
    await main.locator('select').selectOption('cleanup.expired');
    await main.locator('input').first().fill('NDT');
    await main.locator('button', { hasText: 'Run job' }).click();
    await expect(main).toContainText('Lower case letters, digits and underscores');
    await main.locator('input').first().fill('ndt');
    await main.locator('button', { hasText: 'Run job' }).click();
    await expectToast(page, 'Job cleanup.expired queued as');
  });

  test('Create organisation warns that the slug is permanent, checks the form and adds the organisation', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Create organisation').click();
    await expect(dialog(page)).toBeVisible();
    await expect(tab(page, 'Organisations')).toHaveAttribute('aria-selected', 'true');
    await expect(dialog(page)).toContainText('The slug cannot be changed after the organisation is created.');
    await dialog(page).locator('button', { hasText: /^Create$/ }).click();
    await expect(dialog(page)).toContainText('Lower case letters, digits and underscores, 2 to 40, starting with a letter.');
    await expect(dialog(page)).toContainText('Enter a valid email address.');
    await expectOverlayReadable(page);
    const inputs = dialog(page).locator('input');
    await inputs.nth(0).fill('ndt');
    await inputs.nth(1).fill('PT Nusantara Lagi');
    await inputs.nth(3).fill('it.admin@nusantara.example');
    await inputs.nth(4).fill('Andi Wijaya');
    await dialog(page).locator('button', { hasText: /^Create$/ }).click();
    await expect(dialog(page).locator('[role="alert"]').first()).toContainText('An organisation with this slug exists');
    await inputs.nth(0).fill('klinik_sehat');
    await inputs.nth(1).fill('Klinik Sehat');
    await dialog(page).locator('select').selectOption('Asia/Makassar');
    await dialog(page).locator('button', { hasText: /^Create$/ }).click();
    await expect(dialog(page)).toContainText('Organisation created. The slug klinik_sehat cannot be changed.');
    await expect(dialog(page)).toContainText('The invitation was emailed to it.admin@nusantara.example.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(page.locator('main table')).toContainText('klinik_sehat');
    await expect(page.locator('main table tbody tr')).toHaveCount(4);
  });

  test('Install licence installs the licence of one organisation', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Organisations').click();
    const row = page.locator('main table tbody tr', { hasText: 'bsd' });
    await expect(row).toContainText('Grace period');
    await row.locator('button', { hasText: 'Install licence' }).click();
    await expect(dialog(page)).toContainText('Install a licence for PT Bank Sentosa Digital');
    await dialog(page).locator('button', { hasText: 'Install licence' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose a licence file or paste the licence first.');
    await dialog(page).locator('textarea').fill(JSON.stringify({ license_id: 'LIC-BSD-2027', signature: 'ed25519:sample', valid_until: '2027-09-30' }));
    await dialog(page).locator('button', { hasText: 'Install licence' }).click();
    await expectToast(page, 'Licence of PT Bank Sentosa Digital installed');
    await expect(row).toContainText('Valid');
    await expect(row).toContainText('30 Sep 2027');
  });

  test('Install pack follows the installation; a file that is not a signed bundle is refused at the field', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Framework packs').click();
    const main = page.locator('main');
    await expect(main.locator('table')).toContainText('ISO27001-2022');
    const input = main.locator('input[type="file"]');
    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await main.locator('button', { hasText: /^Install$/ }).click();
    await expect(main.locator('[role="alert"]').first()).toContainText('this is not a signed pack bundle');
    await input.setInputFiles({ name: 'ISO27001-2022-1.3.0.bundle', mimeType: 'application/octet-stream', buffer: Buffer.from([0x1f, 0x8b]) });
    await main.locator('button', { hasText: /^Install$/ }).click();
    await expect(main).toContainText('ISO27001-2022 1.3.0 was verified and is being installed.');
    await expect(main).toContainText('ISO27001-2022 1.3.0 is installed.', { timeout: 15_000 });
    await expect(main.locator('table tbody tr', { hasText: '1.3.0' })).toContainText('Installed');
  });

  test('Reset sign-in factor asks for a confirmation and names the account', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Accounts').click();
    const main = page.locator('main');
    await main.locator('input').fill('rina.kusuma@nusantaradigital.co.id');
    await main.locator('textarea').fill('short');
    await main.locator('button', { hasText: 'Reset factor' }).click();
    await expect(main).toContainText('Give a reason of at least 10 characters.');
    await main.locator('textarea').fill('Lost phone, identity checked by video call');
    await main.locator('button', { hasText: 'Reset factor' }).click();
    await expect(dialog(page)).toContainText('rina.kusuma@nusantaradigital.co.id');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Reset factor' }).click();
    await expectToast(page, 'The sign-in factor of rina.kusuma@nusantaradigital.co.id was reset');
  });

  for (const theme of ['light', 'dark']) {
    test(`every section is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(ui.title(page)).toHaveText('Konsol operator');
      for (const label of ['Kesehatan', 'Pekerjaan', 'Organisasi', 'Paket framework', 'Akun']) {
        await tab(page, label).click();
        await expect(page.locator('main [role="tabpanel"]')).not.toContainText('Memuat');
        await page.waitForTimeout(300);
        await expectReadableText(page, 4.5);
      }
      await ui.pageAction(page, 'Buat organisasi').click();
      await expect(dialog(page)).toContainText('Slug tidak dapat diubah setelah organisasi dibuat.');
      await expectOverlayReadable(page);
    });
  }
});
