import { test, expect, ui, openApp, go, openRow, listRow, search, chip, switchMs, drawerFact, expectToast, expectOverlayReadable } from '../helpers.js';

// The controls and requirements forms of the sample build (MILESTONE-2 M2-11): the entry panel of the Controls detail
// with Edit entry (owner, justification, linked risks, operating frequency), Mark not applicable with the BR-03 warning
// under the field after Save, the APPL-ASSESS reason on a clause row, Reject of an entry that waits for verification,
// and Delete entry. "Add control" opens the Add form in the sample build too; the API project covers its Save in
// e2e/api-only/controls-edit.spec.js. @sample-only.
const panel = (page) => ui.drawer(page).locator('[data-m11="entry"]');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

async function openControls(page) {
  await openApp(page);
  await go(page, 'Controls & requirements');
}

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Controls and requirements forms @sample-only', () => {
  test('Add control opens the Add form in the sample build', async ({ page }) => {
    await openControls(page);
    await ui.pageAction(page, 'Add control').click();
    await expect(dialog(page)).toContainText('Add control or requirement');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('Edit entry changes the owner, justification, linked risks and frequency of a control', async ({ page }) => {
    await openControls(page);
    await openRow(page, 'A.5.1');
    await expect(panel(page)).toContainText('Manage this entry');
    await button(panel(page), 'Edit entry').click();
    await expect(dialog(page)).toContainText('Edit A.5.1');
    await expect(dialog(page).locator('textarea[name="inclusionJustification"]')).toHaveValue('Required by risk treatment; see linked risks.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select').first().selectOption('bagus');
    await dialog(page).locator('textarea[name="inclusionJustification"]').fill('Required by the treatment of R-003.');
    await button(dialog(page), 'Remove R-014').click();
    await dialog(page).locator('select[name="frequencyCode"]').selectOption('quarterly');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'A.5.1 saved');
    await expect(dialog(page)).toHaveCount(0);
    await expect(drawerFact(page, 'Owner')).toHaveText('Bagus Prasetyo, IT Infrastructure Lead');
    await expect(drawerFact(page, 'Justification')).toHaveText('Required by the treatment of R-003.');
    await expect(drawerFact(page, 'Linked risks')).toHaveText('R-003');
    await expect(drawerFact(page, 'Operating frequency')).toHaveText('Quarterly');
  });

  test('an applicable control keeps a linked risk (BR-02)', async ({ page }) => {
    await openControls(page);
    await openRow(page, 'A.5.1');
    await button(panel(page), 'Edit entry').click();
    await button(dialog(page), 'Remove R-003').click();
    await button(dialog(page), 'Remove R-014').click();
    await button(dialog(page), 'Save').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Link this applicable entry to at least one risk.');
    await expectOverlayReadable(page);
  });

  test('Mark not applicable shows the BR-03 warning under the field after Save', async ({ page }) => {
    await openControls(page);
    const before = Number(await chip(page, 'Not applicable').locator('span').innerText());
    await openRow(page, 'A.5.2');
    await button(panel(page), 'Mark not applicable').click();
    await button(dialog(page), 'Mark not applicable').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Explain why it does not apply.');
    await dialog(page).locator('textarea').fill('n/a');
    await button(dialog(page), 'Mark not applicable').click();
    await expect(dialog(page)).toContainText('Saved. Check the warnings below.');
    await expect(dialog(page).locator('.mx-m11-warn')).toHaveText('The exclusion justification does not look meaningful. Explain why this does not apply.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(async () => Number(await chip(page, 'Not applicable').locator('span').innerText())).toBe(before + 1);
  });

  test('a clause row cannot be marked not applicable, and its badges come from the target', async ({ page }) => {
    await openControls(page);
    await switchMs(page, 'QMS');
    await chip(page, 'All').click();
    await search(page, 'Cl. 5.2');
    await openRow(page, 'Cl. 5.2');
    await expect(panel(page)).toContainText('Always applicable');
    await expect(panel(page)).toContainText('Written record required');
    const na = button(panel(page), 'Mark not applicable');
    await expect(na).toBeDisabled();
    await expect(panel(page)).toContainText('A clause requirement always applies and cannot be marked not applicable.');
    await button(panel(page), 'Edit entry').click();
    await expect(dialog(page).locator('input[type="radio"]').first()).toBeDisabled();
    await expectOverlayReadable(page);
  });

  test('Reject returns an entry that waits for verification to Partially implemented', async ({ page }) => {
    await openControls(page);
    await switchMs(page, 'QMS');
    await chip(page, 'All').click();
    await search(page, 'Cl. 8.7');
    await openRow(page, 'Cl. 8.7');
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    await button(panel(page), 'Reject').click();
    await expect(dialog(page)).toContainText('The entry goes back to Partially implemented.');
    await dialog(page).locator('textarea').fill('The calibration log misses September.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Reject').click();
    await expectToast(page, 'Cl. 8.7 returned to Partially implemented');
    await expect(listRow(page, 'Cl. 8.7')).toContainText('Partial');
  });

  test('Delete entry asks for a reason of 10 characters, and the sample data keeps the entry', async ({ page }) => {
    await openControls(page);
    await openRow(page, 'A.5.3');
    await button(panel(page), 'Delete entry').click();
    await dialog(page).locator('textarea').fill('Duplicate');
    await button(dialog(page), 'Delete entry').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Give a reason of at least 10 characters.');
    await dialog(page).locator('textarea').fill('Duplicate of A.5.2, merged');
    await button(dialog(page), 'Delete entry').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('The sample data keeps every entry.');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(ui.drawer(page)).toBeVisible();
  });

  test('the panel and the Edit form are in Indonesian', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Kontrol & persyaratan');
    await openRow(page, 'A.5.1');
    await expect(panel(page)).toContainText('Kelola entri ini');
    await button(panel(page), 'Ubah entri').click();
    await expect(dialog(page)).toContainText('Justifikasi penyertaan');
    await expect(dialog(page)).toContainText('Frekuensi operasi');
    await expectOverlayReadable(page);
  });
});
