import { test, expect, ui, go, openApp, switchMs, openRow, listRow, drawerAction, expectToast, expectOverlayReadable } from '../helpers.js';

// The activity forms against the api (MILESTONE-2 M2-11). rina, MS Manager in every demo system, starts a not started
// activity of the BCMS gate phase (activity transition to in_progress), records a blocker on an activity in progress
// with a gate item of the snapshot and a reason (BR-39), with the BR-46 count of the gate phase before, and gets the
// BR-12 refusal for an activity of the ISMS behind its unverified critical gate (product decision 4: the hard block
// applies only at critical gates).
const panel = (page) => ui.drawer(page).locator('[data-m11="activity"]');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const step = (page, name) => page.locator(`main button[title="${name}"]`);

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openBcmsGatePhase(page) {
  await openApp(page);
  await switchMs(page, 'BCMS');
  await go(page, 'Phase board');
  await step(page, 'BIA & risk assessment').click();
}

test.describe('Activity forms against the api @api-only', () => {
  test('Start moves a not started activity of the gate phase to In progress', async ({ page }) => {
    await openBcmsGatePhase(page);
    await openRow(page, '4.6');
    await expect(panel(page)).toContainText('Work on this activity');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(panel(page), 'Start').click();
    await expectToast(page, '4.6 started');
    await expect(listRow(page, '4.6')).toContainText('In progress');
  });

  test('Record blocker names a gate item and the reason, and the activity is blocked by it', async ({ page }) => {
    await openBcmsGatePhase(page);
    await openRow(page, '4.5');
    await drawerAction(page, 'Record blocker').click();
    await expect(dialog(page)).toContainText('Record blocker for 4.5');
    // BR-46: the gate phase holds 2 blocked activities against 3 open checkpoint items before this blocker.
    await expect(dialog(page)).toContainText('Checkpoint phase 4: 2 blocked activities and 3 open checkpoint items.');
    await expect(dialog(page)).toContainText('The number of blocked activities does not match the open checkpoint items.');
    await button(dialog(page), 'Record blocker').click();
    await expect(dialog(page)).toContainText('Choose the checkpoint item that holds this activity.');
    await dialog(page).locator('[role="option"]', { hasText: 'Cl. 8.2' }).click();
    await dialog(page).locator('textarea[name="blockerReason"]').fill('The risk assessment waits for the approved BIA of the data centre.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record blocker').click();
    await expectToast(page, 'Blocker recorded and linked to checkpoint item Cl. 8.2');
    await expect(dialog(page)).toHaveCount(0);
    await expect(listRow(page, '4.5')).toContainText('Blocked by Cl. 8.2');
  });

  test('Start of an activity behind an unverified critical gate is refused with BR-12', async ({ page }) => {
    await openApp(page);
    await go(page, 'Phase board');
    await step(page, 'Improvement & audit readiness').click();
    await openRow(page, '9.7');
    await button(panel(page), 'Start').click();
    await expect(panel(page).locator('[role="alert"]')).toContainText('stays locked until every activity of critical checkpoint phase');
    await expectOverlayReadable(page);
  });
});
