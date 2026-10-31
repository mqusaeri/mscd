import { test, expect, ui, openScreen, metaById, expectToast, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// Policies to confirm of the sample build (MILESTONE-3 M3-05, D.7 "Confirming", H.7): every persona starts with its
// confirmations done, so no banner shows. The Management System Manager asks the Management System Managers of the ISMS
// to confirm POL-14; the banner counts the open confirmation and opens the screen; "Confirm" waits until the document
// is opened and the statement ticked; the confirmation moves to Done and the banner goes. @sample-only: the API project
// covers the screen in e2e/api-only/my-confirmations.spec.js.
const meta = metaById('my-confirmations');
const register = metaById('acknowledgements');
const body = (page) => page.locator('main [data-screen="my-confirmations"]');
const banner = (page) => page.locator('[data-confirmation-banner]');
const dialog = (page) => ui.modal(page).last();
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Policies to confirm @sample-only', () => {
  test('the Domain Owner persona has nothing open: the all-done scene, the done list and no banner', async ({ page }) => {
    await openScreen(page, meta);
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await expect(body(page)).toContainText('Nothing to confirm');
    await expect(body(page).locator('svg').first()).toBeVisible();
    await expect(body(page).locator('tbody tr', { hasText: 'POL-01' })).toContainText(/Confirmed on \d{2} [A-Z][a-z]{2} 2026/);
    await expect(banner(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await inBothThemes(page, () => expectReadableText(page, 4.5));
  });

  test('a new request shows the banner; the version is opened before it is confirmed', async ({ page }) => {
    await openScreen(page, register);
    await expect(banner(page)).toHaveCount(0);
    await ui.pageAction(page, 'Ask for confirmation').click();
    await dialog(page).locator('select[name="document"]').selectOption('POL-14');
    await dialog(page).getByLabel('Only the roles I choose').check();
    await dialog(page).getByLabel('Management System Manager').check();
    await button(dialog(page), 'Send the request').click();
    await expectToast(page, 'Asked 1 person to confirm POL-14 version 1.0');

    await expect(banner(page)).toHaveAttribute('data-confirmation-banner', '1');
    await expect(banner(page)).toContainText('You have 1 policy to confirm');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    await button(banner(page), 'Open Policies to confirm').click();
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await expect(banner(page)).toHaveCount(0);

    const item = body(page).locator('[data-confirmation="POL-14"]');
    await expect(item).toContainText('Not opened yet');
    await expect(item).toContainText('Confirm by 13 Oct 2026');
    await expect(button(item, 'Confirm')).toBeDisabled();
    await expect(item).toContainText('Open the document first.');
    await expect(item.getByRole('checkbox')).toBeDisabled();
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    await button(item, 'Open document').click();
    await expectToast(page, 'The sample build has no stored files, so the document counts as opened.');
    await expect(item).toContainText(/Opened on/);
    await expect(item).toContainText('Tick the statement first.');
    await item.getByLabel('I have read and understood this document').check();
    await button(item, 'Confirm').click();
    await expectToast(page, 'You confirmed POL-14 version 1.0');
    await expect(body(page)).toContainText('Nothing to confirm');
    await expect(body(page).locator('tbody tr', { hasText: 'POL-14' }).first()).toContainText('Confirmed on 29 Sep 2026');
  });
});
