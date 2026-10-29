import { test, expect, ui, openApp, go, openRow, listRow, listRows, search, tab, expectToast, expectOverlayReadable } from '../helpers.js';

// The evidence forms of the sample build (MILESTONE-2 M2-11): "Define evidence" of a control opens New evidence, which
// creates the record and attaches its first file through the repository picker; the evidence panel edits the record,
// adds a target in another system (BR-23 warning) and removes it again, never the last one; the freshness limits are
// set and reset to the default. "New evidence" and "Freshness limits" are page actions of Evidence freshness in both
// builds; the API project covers them in e2e/api-only/evidence-edit.spec.js. @sample-only.
const panel = (page) => ui.drawer(page).locator('[data-m11="evidence"]');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Evidence forms @sample-only', () => {
  test('Evidence freshness offers New evidence and Freshness limits as page actions', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await expect(page.locator('main > div > div:first-child button[title]')).toHaveText(['Run integrity check', 'New evidence', 'Freshness limits']);
    await ui.pageAction(page, 'New evidence').click();
    await expect(dialog(page)).toContainText('New evidence');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await ui.pageAction(page, 'Freshness limits').click();
    await expect(dialog(page)).toContainText('Freshness limits');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('Define evidence creates a record for a control and attaches its first file', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.3');
    await button(ui.drawer(page).locator('[data-m11="define"]'), 'Define evidence').click();
    await expect(dialog(page)).toContainText('New evidence');
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    expect(code).toMatch(/^EV-\d{4}$/);
    await expect(dialog(page).locator('.mx-m11-codes')).toContainText('A.5.3');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="title"]').fill('Quarterly segregation of duties review');
    await dialog(page).locator('select[name="frequencyCode"]').selectOption('quarterly');
    await button(dialog(page), 'Create evidence').click();
    await expect(dialog(page)).toContainText('Attach the first file');
    await expect(dialog(page)).toContainText(`${code} has no file yet, so it counts as critical until one is attached.`);
    // The empty state of the record's files shows the no-evidence scene of the illustration library (MOT-03).
    await expect(dialog(page).locator('.mx-empty')).toContainText('No file linked yet');
    await expect(dialog(page).locator('.mx-empty-art svg')).toBeVisible();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Choose file').click();
    await expect(dialog(page)).toContainText('Select evidence file from repository');
    await button(dialog(page), 'Link selected file').click();
    await expectToast(page, `${code}: Backup-Job-Log-Sep-2026.xlsx attached`);
    await expect(dialog(page)).toHaveCount(0);
    await go(page, 'Evidence freshness');
    await search(page, code);
    await expect(listRow(page, code)).toContainText('Quarterly segregation of duties review');
    await expect(listRow(page, code)).toContainText('Fresh');
  });

  test('New evidence refuses a code that exists and a record without a target', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.3');
    await button(ui.drawer(page).locator('[data-m11="define"]'), 'Define evidence').click();
    await dialog(page).locator('input[name="code"]').fill('EV-0313');
    await expect(dialog(page).locator('input[name="title"]')).toHaveValue('Segregation of duties');
    await dialog(page).locator('input[name="title"]').fill('');
    await button(dialog(page), 'Remove A.5.3').click();
    await button(dialog(page), 'Create evidence').click();
    await expect(dialog(page)).toContainText('EV-0313 already exists.');
    await expect(dialog(page)).toContainText('Give a title of up to 255 characters.');
    await expect(dialog(page)).toContainText('Choose at least one control or requirement.');
    await expectOverlayReadable(page);
  });

  test('the evidence panel edits the record, adds a target in another system and removes it again', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await tab(page, 'Critical').click();
    await openRow(page, 'EV-0313');
    await expect(panel(page)).toContainText('Manage this evidence');
    await expect(panel(page)).toContainText('A.8.13 in ISMS');
    await expect(button(panel(page), 'Remove A.8.13')).toBeDisabled();
    await expect(panel(page)).toContainText('An evidence record keeps at least one target.');
    await expectOverlayReadable(page);

    await button(panel(page), 'Edit evidence').click();
    await expect(dialog(page)).toContainText('Edit EV-0313');
    await dialog(page).locator('input[name="title"]').fill('Backup job log and restore test');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'EV-0313 saved');
    await expect(ui.drawer(page)).toContainText('Backup job log and restore test');

    await button(panel(page), 'Add target').click();
    await dialog(page).locator('select[name="system"]').selectOption('qms');
    await dialog(page).locator('input[type="search"]').fill('7.5');
    await dialog(page).locator('[role="option"]').first().click();
    await dialog(page).locator('textarea[name="mappingNote"]').fill('The same backup log serves document control.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Add target').click();
    await expect(dialog(page)).toContainText('Saved. Check the warnings below.');
    await expect(dialog(page)).toContainText('This requirement is similar but not identical.');
    await button(dialog(page), 'Close').click();
    await expect(panel(page)).toContainText('in QMS');
    await expect(button(panel(page), 'Remove A.8.13')).toBeEnabled();

    const added = panel(page).locator('li', { hasText: 'in QMS' });
    await added.locator('button').click();
    await dialog(page).locator('textarea').fill('Mapped to the wrong clause');
    await button(dialog(page), 'Remove target').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(panel(page)).not.toContainText('in QMS');
  });

  test('the freshness limits are set for the system and reset to the default', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await listRows(page).first().click();
    await button(panel(page), 'Freshness limits').click();
    await expect(dialog(page)).toContainText('Freshness limits of ISMS');
    const monthly = dialog(page).locator('form[data-frequency="monthly"]');
    await expect(monthly).toContainText('Default');
    await monthly.locator('input[name="expiredFactor"]').fill('1.1');
    await button(monthly, 'Save').click();
    await expect(monthly.locator('[role="alert"]')).toHaveText('The expired factor must be at least the aging factor.');
    await monthly.locator('input[name="graceDays"]').fill('5');
    await monthly.locator('input[name="expiredFactor"]').fill('2.5');
    await button(monthly, 'Save').click();
    await expectToast(page, 'Freshness limits of Monthly saved');
    await expect(monthly).toContainText('Set for this system');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(monthly, 'Reset to default').click();
    await expectToast(page, 'Freshness limits of Monthly back to the default');
    await expect(monthly).toContainText('Default');
    await expect(monthly.locator('input[name="graceDays"]')).toHaveValue('1');
  });

  test('the evidence panel is in Indonesian', async ({ page }) => {
    await openApp(page, '?lang=id');
    await go(page, 'Kesegaran bukti');
    await listRows(page).first().click();
    await expect(panel(page)).toContainText('Kelola bukti ini');
    await expect(panel(page)).toContainText('Kontrol dan persyaratan yang dipenuhi');
    await expect(button(panel(page), 'Ubah bukti')).toBeVisible();
  });
});
