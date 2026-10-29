import {
  test, expect, ui, openApp, go, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Auditor access of the sample build (MILESTONE-2 M2-15): the guest auditor grants of the ISMS with "Grant access"
// (email and 1 to 30 days) and "Revoke", the evidence packs with their CSV manifest, the read-only view of the Internal
// Auditor persona, and "Auditor access" on Audit readiness, which opens the "Grant auditor access" form in the sample
// build too. @sample-only: the API project covers the screen in e2e/api-only/auditor-access.spec.js.
const meta = metaById('auditor-access');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: name });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Auditor access @sample-only', () => {
  test('lists the grants, grants access for a number of days and revokes it', async ({ page }) => {
    await openScreen(page, meta);
    await expect(tab(page, 'Guest access')).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0)).toContainText('dwi.hartanto@sertifikasi-nusantara.co.id');
    await expect(rows(page).nth(0)).toContainText('Active');
    await expect(rows(page).nth(0)).toContainText('by Rina Kusuma');
    await expect(rows(page).nth(1)).toContainText('Revoked');
    await expect(rows(page).nth(1).locator('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    await ui.pageAction(page, 'Grant access').click();
    await expect(dialog(page)).toContainText('Grant auditor access');
    await expect(dialog(page).locator('input[name="days"]')).toHaveValue('14');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="email"]').fill('auditor');
    await dialog(page).locator('input[name="days"]').fill('31');
    await button(dialog(page), 'Grant access').click();
    await expect(dialog(page)).toContainText('Enter an email address.');
    await expect(dialog(page)).toContainText('Enter a whole number from 1 to 30.');
    await dialog(page).locator('input[name="email"]').fill('surveillance.lead@sertifikasi-nusantara.co.id');
    await dialog(page).locator('input[name="days"]').fill('7');
    await button(dialog(page), 'Grant access').click();
    await expectToast(page, 'Guest access created, valid 7 days. The link was emailed to surveillance.lead@sertifikasi-nusantara.co.id.');
    await expect(dialog(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(3);
    const fresh = rows(page).filter({ hasText: 'surveillance.lead@' });
    await expect(fresh).toContainText('Not used yet');
    await button(fresh, 'Revoke').click();
    await expect(dialog(page)).toContainText('The access of surveillance.lead@sertifikasi-nusantara.co.id ends at once');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Revoke').click();
    await expectToast(page, 'Access of surveillance.lead@sertifikasi-nusantara.co.id revoked');
    await expect(fresh).toContainText('Revoked');
  });

  test('lists the evidence packs and downloads the manifest', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Evidence packs').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Ready');
    await expect(rows(page).first()).toContainText('SharePoint Online');
    await expect(rows(page).first()).toContainText('/Compliance/_packs/ISMS/Surveillance 1/');
    await expect(rows(page).first()).toContainText(/\d+ files, \d+ exceptions/);
    const [download] = await Promise.all([page.waitForEvent('download'), button(rows(page).first(), 'Download manifest \\(CSV\\)').click()]);
    expect(download.suggestedFilename()).toMatch(/^isms-evidence-pack-.*-manifest\.csv$/);
    await expectReadableText(page, 4.5);
  });

  test('the Internal Auditor reads the evidence packs only; Auditor access of Audit readiness opens the grant form', async ({ page }) => {
    await page.goto(`/?screen=auditor-access&persona=auditor`);
    await expect(page.locator('main [data-screen="auditor-access"]')).toBeVisible();
    await expect(page.locator('main [role="tab"]')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Evidence packs');
    await expect(ui.pageAction(page, 'Grant access')).toHaveCount(0);

    await openApp(page);
    await go(page, 'Audit readiness');
    await ui.pageAction(page, 'Auditor access').click();
    await expect(dialog(page)).toContainText('Grant auditor access');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('speaks Indonesian', async ({ page }) => {
    await openScreen(page, meta, 'lang=id');
    await expect(tab(page, 'Akses tamu')).toBeVisible();
    await expect(page.locator('main thead')).toContainText('Alamat email');
    await ui.pageAction(page, 'Berikan akses').click();
    await expect(dialog(page)).toContainText('Berikan akses auditor');
    await expect(dialog(page)).toContainText('Berlaku selama (hari)');
  });
});
