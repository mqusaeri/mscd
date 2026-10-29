import { test, expect, ui, openApp, go, openRow, drawerAction, expectToast, expectOverlayReadable } from '../helpers.js';

// The activity forms of the sample build (MILESTONE-2 M2-11): the activity panel of the Phase board shows "Start" on a
// not started activity, disabled with its reason because the sample data keeps the status of activities; "Record
// blocker" keeps its Milestone 1 toast, because the sample data source only acknowledges a blocker (M2-11 deviation 3),
// so the form could not save here. The API project covers Start and the Record blocker form in
// e2e/api-only/phases-edit.spec.js. @sample-only.
const panel = (page) => ui.drawer(page).locator('[data-m11="activity"]');
const step = (page, name) => page.locator(`main button[title="${name}"]`);

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Activity forms @sample-only', () => {
  test('a not started activity offers Start, disabled with the reason of the sample build', async ({ page }) => {
    await openApp(page);
    await go(page, 'Phase board');
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.7');
    await expect(panel(page)).toContainText('Work on this activity');
    await expect(panel(page).locator('button', { hasText: /^Start$/ })).toBeDisabled();
    await expect(panel(page)).toContainText('The sample data keeps the status of activities as it is.');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });

  test('an activity in progress has no Start, and Record blocker keeps its toast', async ({ page }) => {
    await openApp(page);
    await go(page, 'Phase board');
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.4');
    await expect(panel(page)).toHaveCount(0);
    await drawerAction(page, 'Record blocker').click();
    await expectToast(page, 'Blocker recorded and linked to the gate item');
    await expect(ui.modal(page)).toHaveCount(0);
  });

  test('the activity panel is in Indonesian', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Papan fase');
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.7');
    await expect(panel(page)).toContainText('Kerjakan aktivitas ini');
    await expect(panel(page).locator('button', { hasText: /^Mulai$/ })).toBeDisabled();
  });
});
