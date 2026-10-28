import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Management review of the sample build (MILESTONE-2 M2-14): the reviews with the completeness of their mandatory
// inputs, "Plan review", "Edit", the inputs per definition, "Mark held" and "Close" with the decisions and the BR-13
// and BR-14 messages. @sample-only: the API project covers the screen in e2e/api-only/management-review.spec.js.
const meta = metaById('management-review');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main tr[data-hov]');
const row = (page, text) => rows(page).filter({ hasText: text });
const input = (page, code) => drawer(page).locator(`[data-input="${code}"]`);

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Management review @sample-only', () => {
  test('lists the reviews with the completeness of their mandatory inputs', async ({ page }) => {
    await openScreen(page, meta);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0)).toContainText('MR-2026');
    await expect(rows(page).nth(0)).toContainText('8 of 10 complete');
    await expect(rows(page).nth(0)).toContainText('Planned');
    await expect(rows(page).nth(1)).toContainText('MR-2025');
    await expect(rows(page).nth(1)).toContainText('Closed');
    await expect(rows(page).nth(1)).toContainText('Hendra Wijaya');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('records the missing inputs, holds the review and closes it with the decisions (BR-13, BR-14)', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'MR-2026').click();
    await expect(drawer(page)).toContainText('MR-2026 Management review 2026');
    await expect(input(page, 'MR-04')).toContainText('Missing');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Mark held').click();
    await expect(dialog(page)).toContainText('Mark review MR-2026 held');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="heldAt"]').fill('2026-09-28');
    await button(dialog(page), 'Mark held').click();
    await expectToast(page, 'Management review MR-2026 marked held');
    await expect(row(page, 'MR-2026')).toContainText('28 Sep 2026');
    await button(drawer(page), 'Close review').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="decisionsText"]').fill('Budget approved for privileged access management');
    await button(dialog(page), 'Close review').click();
    await expect(dialog(page)).toContainText('The management review cannot be closed while mandatory inputs are empty for a linked system.');
    await expect(dialog(page)).toContainText('BR-13');
    await page.keyboard.press('Escape');
    for (const [code, text] of [['MR-04', 'Two nonconformities this year, both with corrective actions'], ['MR-09', 'Risk assessment 2026 approved; four treatments open']]) {
      await button(input(page, code), 'Record input').click();
      await expect(dialog(page)).toContainText(code);
      await dialog(page).locator('textarea[name="content"]').fill(text);
      await button(dialog(page), 'Save').click();
      await expectToast(page, `Input ${code} saved`);
      await expect(input(page, code)).toContainText('Complete');
      await expect(input(page, code)).toContainText(text);
    }
    await expect(drawer(page)).toContainText('10 of 10 complete');
    await button(drawer(page), 'Close review').click();
    await dialog(page).locator('textarea[name="decisionsText"]').fill('');
    await button(dialog(page), 'Close review').click();
    await expect(dialog(page)).toContainText('The management review cannot be closed without recorded decisions.');
    await expect(dialog(page)).toContainText('BR-14');
    await dialog(page).locator('textarea[name="decisionsText"]').fill('Budget approved for privileged access management; supplier reviews every quarter');
    await button(dialog(page), 'Close review').click();
    await expectToast(page, 'Management review MR-2026 closed');
    await expect(drawer(page)).toContainText('This review is closed with its decisions.');
    await expect(drawer(page)).toContainText('supplier reviews every quarter');
    await expect(drawer(page).locator('button', { hasText: 'Edit input' })).toHaveCount(0);
  });

  test('plans a review and changes its planned date', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Plan review').click();
    await expect(dialog(page)).toContainText('Plan a management review');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('MR-2026-01');
    await button(dialog(page), 'Plan review').click();
    await expect(dialog(page)).toContainText('Required.');
    await dialog(page).locator('input[name="code"]').fill('MR-2027');
    await dialog(page).locator('input[name="title"]').fill('Management review 2027');
    await dialog(page).locator('input[name="plannedAt"]').fill('2027-10-27');
    await dialog(page).locator('select').first().selectOption('hendra');
    await button(dialog(page), 'Plan review').click();
    await expectToast(page, 'Management review MR-2027 planned');
    await expect(row(page, 'MR-2027')).toContainText('0 of 10 complete');
    await expect(drawer(page)).toContainText('MR-2027 Management review 2027');
    await button(drawer(page), 'Edit').click();
    await expect(dialog(page)).toContainText('Edit review MR-2027');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('Nothing changed.');
    await dialog(page).locator('input[name="plannedAt"]').fill('2027-11-03');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Management review MR-2027 saved');
    await expect(row(page, 'MR-2027')).toContainText('3 Nov 2027');
  });

  test('a joint review links the inputs of another system, which are recorded from that system', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Plan review').click();
    await dialog(page).locator('input[name="code"]').fill('MR-2027-J');
    await dialog(page).locator('input[name="plannedAt"]').fill('2027-10-27');
    await dialog(page).locator('select').first().selectOption('hendra');
    await dialog(page).locator('label', { hasText: /^QMS$/ }).click();
    await button(dialog(page), 'Plan review').click();
    await expectToast(page, 'Management review MR-2027-J planned');
    await expect(row(page, 'MR-2027-J')).toContainText('ISMS, QMS');
    await expect(drawer(page)).toContainText('Inputs of QMS');
    await expect(drawer(page)).toContainText('Recorded from QMS: switch to that system to change it.');
  });

  test('Top Management plans reviews in the sample; the Internal Auditor reads them', async ({ page }) => {
    await page.goto('/?screen=management-review&persona=top');
    await expect(page.locator('main h1')).toHaveText('Management review');
    await expect(ui.pageAction(page, 'Plan review')).toBeVisible();
    await page.goto('/?screen=management-review&persona=auditor');
    await expect(page.locator('main h1')).toHaveText('Management review');
    await expect(ui.pageAction(page, 'Plan review')).toHaveCount(0);
    await row(page, 'MR-2026').click();
    await expect(drawer(page).locator('button', { hasText: 'Record input' })).toHaveCount(0);
    await expect(drawer(page).locator('button', { hasText: 'Mark held' })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`the list, the drawer and the plan form are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(page.locator('main')).toContainText('8 dari 10 lengkap');
      await expectReadableText(page, 4.5);
      await row(page, 'MR-2026').click();
      await expect(drawer(page)).toContainText('Masukan');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await ui.pageAction(page, 'Rencanakan tinjauan').click();
      await expect(dialog(page)).toContainText('Rencanakan tinjauan manajemen');
      await expectOverlayReadable(page);
    });
  }
});
