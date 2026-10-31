import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, ui, go, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, pageSettled } from '../helpers.js';

// Organisation export in the sample build (MILESTONE-3 M3-09, D.4): the exports of PT Nusantara Digital Teknologi with
// status, requester, approval, size, parts and expiry; Rina Kusuma (the manager persona, a Tenant Admin) approves the
// request of Tono Hartono, which MSCD builds, and downloads each part and the manifest, whose SHA-256 equals the value
// shown; a second request waits while one is in flight, a rejection needs a reason, and Rina's own request is closed to
// her ("You requested this export"); after the sample operator moves the organisation to offboarding in the operator
// console, the banner of the read-only period shows on the other screens (readable in both themes) and the note on
// this one. Every dialog and the drawer in both languages and themes. Today is 29 Sep 2026.
// @sample-only: the API project runs e2e/api-only/org-export.spec.js.
const meta = metaById('org-export');
const rows = (page) => page.locator('main [data-org-export] table tbody tr');
const rowOf = (page, status) => rows(page).filter({ has: page.locator(`[data-export-status="${status}"]`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openExports(page, query = '') {
  await openScreen(page, meta, query);
  await expect(rows(page)).toHaveCount(4);
}

test.describe('Organisation export @sample-only', () => {
  test('lists the exports; Rina approves Tono\'s request, MSCD builds it and every file matches its SHA-256', async ({ page }) => {
    await openExports(page);
    const main = page.locator('main');
    for (const header of ['Requested', 'Status', 'Approval', 'Size', 'Ready', 'Downloadable until']) await expect(main.locator('thead')).toContainText(header);
    await expect(rowOf(page, 'requested')).toContainText('by Tono Hartono');
    await expect(rowOf(page, 'requested')).toContainText('Another Tenant Admin decides');
    await expect(rowOf(page, 'ready')).toContainText('Approved by Tono Hartono');
    await expect(rowOf(page, 'ready')).toContainText('2 parts');
    await expect(rowOf(page, 'ready')).toContainText('3 Oct 2026');
    await expect(rowOf(page, 'rejected')).toContainText('Rejected by Tono Hartono');
    await expect(rowOf(page, 'expired')).toContainText('by MSCD operator');
    await expect(rowOf(page, 'expired')).toContainText('Not needed: asked by the operator');
    await expectReadableText(page, 4.5);
    await expectNoHorizontalOverflow(page);
    // Approve Tono's request.
    await rowOf(page, 'requested').getByRole('button', { name: 'Approve' }).click();
    const dialog = ui.modal(page);
    await expect(dialog).toContainText('Approve this export?');
    await expect(dialog).toContainText('MSCD builds the export of the whole organisation now.');
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'Export approved. MSCD builds it now.');
    await expect(main).toContainText('MSCD is building an export. This list refreshes by itself until it is ready.');
    await main.getByRole('button', { name: 'Refresh' }).click();
    await expect(rows(page).first().locator('[data-export-status="ready"]')).toBeVisible({ timeout: 15_000 });
    await expect(rows(page).first()).toContainText('Approved by Rina Kusuma');
    await expect(main).not.toContainText('MSCD is building an export.');
    // Open it: the parts and the manifest with their SHA-256, and how to check them.
    await rows(page).first().getByRole('button', { name: 'Open' }).click();
    const drawer = ui.drawer(page);
    await expect(drawer.locator('[data-export-status="ready"]')).toBeVisible();
    await expect(drawer).toContainText('Download every part and the manifest.');
    await expect(drawer.locator('[data-how-to-check]')).toContainText('sha256sum mscd-sample-export-ndt-2026-09-29-part-1.txt');
    await expect(drawer.locator('[data-how-to-check]')).toContainText('Get-FileHash mscd-sample-export-ndt-2026-09-29-part-1.txt -Algorithm SHA256');
    await expectOverlayReadable(page);
    const shas = await drawer.locator('[data-sha256]').evaluateAll((els) => els.map((el) => el.getAttribute('data-sha256')));
    expect(shas).toHaveLength(3);
    const buttons = drawer.getByRole('button', { name: 'Download' });
    await expect(buttons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const [download] = await Promise.all([page.waitForEvent('download'), buttons.nth(i).click()]);
      const bytes = await readFile(await download.path());
      expect(createHash('sha256').update(bytes).digest('hex'), download.suggestedFilename()).toBe(shas[i]);
    }
    await expect(drawer.locator('[data-sha256]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);
  });

  test('a second request waits; a rejection needs a reason; the requester cannot approve their own export', async ({ page }) => {
    await openExports(page);
    const main = page.locator('main');
    const dialog = ui.modal(page);
    await ui.pageAction(page, 'Export all data').click();
    await expect(dialog).toContainText('What the export holds');
    await expect(dialog).toContainText('Every document and evidence file stored in the Managed Vault.');
    await expect(dialog).toContainText('Another Tenant Admin must approve the request before MSCD builds the export. You cannot approve your own request.');
    await expect(dialog).toContainText('Every Tenant Admin and every primary Management System Manager is told of the request, the approval and each download');
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Export all data' }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('Another export of this organisation is waiting for approval or being built.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // Reject Tono's request: a reason is required.
    await rowOf(page, 'requested').getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toContainText('Reject this export');
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toContainText('Write the reason for the rejection.');
    await dialog.locator('textarea').fill('Not before the management review in October');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'Export rejected');
    await expect(rowOf(page, 'rejected')).toHaveCount(2);
    // Rina's own request waits for Tono: both decisions are closed to her.
    await ui.pageAction(page, 'Export all data').click();
    await dialog.locator('textarea').fill('Copy for the annual records archive');
    await dialog.getByRole('button', { name: 'Export all data' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'The export waits for another Tenant Admin to approve it.');
    const own = rowOf(page, 'requested');
    await expect(own).toContainText('by Rina Kusuma');
    await expect(own.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(own.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await expect(own).toContainText('You requested this export');
    await own.getByRole('button', { name: 'Open' }).click();
    const drawer = ui.drawer(page);
    await expect(drawer.locator('[data-no-files="requested"]')).toContainText('The files can be downloaded once the export is ready.');
    await expect(drawer).toContainText('You requested this export');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await rowOf(page, 'expired').getByRole('button', { name: 'Open' }).click();
    await expect(drawer.locator('[data-no-files="expired"]')).toContainText('This export has expired and its files were deleted. Ask for a new export.');
  });

  test('during the read-only period after the contract ends, the banner and the note show the end and the deletion date', async ({ page }) => {
    // The sample operator moves the organisation to offboarding in the operator console.
    await openScreen(page, metaById('ops'));
    await page.locator('main [role="tab"]', { hasText: 'Organisations' }).click();
    await page.locator('main table tbody tr', { hasText: 'ndt' }).getByRole('button', { name: 'Manage' }).click();
    const drawer = ui.drawer(page);
    await drawer.getByRole('tab', { name: 'Status', exact: true }).click();
    await drawer.getByRole('button', { name: 'Start offboarding' }).click();
    const dialog = ui.modal(page);
    await dialog.locator('textarea').fill('Contract ends on 30 September 2026');
    await dialog.locator('input').fill('ndt');
    await dialog.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Escape');
    // On another screen, the banner of the host layer for the Tenant Admin.
    await go(page, 'Management systems');
    const banner = page.locator('[data-read-only-banner]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Read-only until 29 Oct 2026');
    await expect(banner).toContainText('MSCD deletes all data of the organisation for good on 28 Nov 2026.');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    // It stays clear of the sidebar.
    const sidebar = await page.locator('aside').boundingBox();
    const box = await banner.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    await banner.getByRole('button', { name: 'Open Organisation export' }).click();
    await expect(ui.title(page)).toHaveText('Organisation export');
    await expect(page.locator('[data-read-only-banner]')).toHaveCount(0);
    await expect(page.locator('main [data-read-only-note]')).toContainText('The contract of this organisation has ended.');
    await expect(rows(page).first()).toContainText('End of contract');
    await expect(rows(page).first()).toContainText('Final export');
    // "Later" puts the banner off for the page session.
    await go(page, 'Management systems');
    await page.locator('[data-read-only-banner]').getByRole('button', { name: 'Later' }).click();
    await expect(page.locator('[data-read-only-banner]')).toHaveCount(0);
    await go(page, 'Licence');
    await expect(page.locator('[data-read-only-banner]')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`every dialog and the drawer are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openExports(page, `lang=id&theme=${theme}`);
      await expectReadableText(page, 4.5);
      const dialog = ui.modal(page);
      await ui.pageAction(page, 'Ekspor semua data').click();
      await expect(dialog).toContainText('Isi ekspor');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await rowOf(page, 'requested').getByRole('button', { name: 'Setujui' }).click();
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await rowOf(page, 'requested').getByRole('button', { name: 'Tolak' }).click();
      await dialog.getByRole('button', { name: 'Tolak' }).click();
      await expect(dialog).toContainText('Tuliskan alasan penolakan.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await rowOf(page, 'ready').getByRole('button', { name: 'Buka' }).click();
      const drawer = ui.drawer(page);
      await expect(drawer).toContainText('Cara memeriksa');
      await pageSettled(page);
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await rowOf(page, 'rejected').getByRole('button', { name: 'Buka' }).click();
      await expect(drawer).toContainText('Ekspor ini ditolak, jadi tidak pernah dibuat.');
      await expectOverlayReadable(page);
    });
  }
});
