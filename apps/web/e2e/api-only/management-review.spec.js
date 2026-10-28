import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// Management review against the api (MILESTONE-2 M2-14, M2-07). In PT Nusantara Digital Teknologi rina is the MS
// Manager of the ISMS (`management_review.manage`) and hendra Top Management (reads reviews, F.6); the seed holds no
// management review.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main tr[data-hov]');
const row = (page, text) => rows(page).filter({ hasText: text });

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Management review against the api @api-only', () => {
  test('rina plans a review, changes it, records the inputs, holds it and closes it with the decisions (BR-13, BR-14)', async ({ page }) => {
    await openApp(page);
    await go(page, 'Management review');
    await expect(page.locator('main')).toContainText('No management review yet');
    await ui.pageAction(page, 'Plan review').click();
    await expect(dialog(page)).toContainText('Plan a management review');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('MR-2026');
    await dialog(page).locator('input[name="plannedAt"]').fill('2026-10-28');
    await dialog(page).locator('select').first().selectOption('hendra');
    await button(dialog(page), 'Plan review').click();
    await expectToast(page, 'Management review MR-2026 planned');
    await expect(row(page, 'MR-2026')).toContainText(/0 of \d+ complete/);
    const total = Number((await row(page, 'MR-2026').innerText()).match(/0 of (\d+) complete/)[1]);
    expect(total).toBeGreaterThan(0);
    await expect(drawer(page)).toContainText('MR-2026 Management review 2026');
    await inBothThemes(page, () => expectOverlayReadable(page));

    await button(drawer(page), 'Edit').click();
    await expect(dialog(page)).toContainText('Edit review MR-2026');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="plannedAt"]').fill('2026-11-03');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Management review MR-2026 saved');
    await expect(row(page, 'MR-2026')).toContainText('3 Nov 2026');

    const inputs = drawer(page).locator('[data-input]');
    await expect(inputs).toHaveCount(total);
    await inputs.first().locator('button', { hasText: 'Record input' }).click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="content"]').fill('All actions of the previous review are closed');
    await button(dialog(page), 'Save').click();
    await expect(drawer(page)).toContainText(`1 of ${total} complete`);

    await button(drawer(page), 'Mark held').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Mark held').click();
    await expectToast(page, 'Management review MR-2026 marked held');
    await button(drawer(page), 'Close review').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="decisionsText"]').fill('Budget approved for privileged access management');
    await button(dialog(page), 'Close review').click();
    await expect(dialog(page)).toContainText('The management review cannot be closed while mandatory inputs are empty for a linked system.');
    await expect(dialog(page)).toContainText('BR-13');
    await page.keyboard.press('Escape');

    for (let i = 1; i < total; i += 1) {
      await inputs.nth(i).locator('button', { hasText: 'Record input' }).click();
      await dialog(page).locator('textarea[name="content"]').fill(`Input ${i + 1} prepared by the ISMS Manager`);
      await button(dialog(page), 'Save').click();
      await expect(inputs.nth(i)).toContainText('Complete');
    }
    await expect(drawer(page)).toContainText(`${total} of ${total} complete`);
    await button(drawer(page), 'Close review').click();
    await dialog(page).locator('textarea[name="decisionsText"]').fill('');
    await button(dialog(page), 'Close review').click();
    await expect(dialog(page)).toContainText('The management review cannot be closed without recorded decisions.');
    await expect(dialog(page)).toContainText('BR-14');
    await dialog(page).locator('textarea[name="decisionsText"]').fill('Budget approved for privileged access management');
    await button(dialog(page), 'Close review').click();
    await expectToast(page, 'Management review MR-2026 closed');
    await expect(row(page, 'MR-2026')).toContainText('Closed');
    await expect(drawer(page)).toContainText('This review is closed with its decisions.');
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('reads the reviews without planning or changing them', async ({ page }) => {
      await openApp(page);
      await go(page, 'Management review');
      await expect(page.locator('main')).toContainText('No management review yet');
      await expect(ui.pageAction(page, 'Plan review')).toHaveCount(0);
      await expect(page.locator('main button', { hasText: 'Plan review' })).toHaveCount(0);
    });
  });
});
