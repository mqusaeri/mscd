import { test, expect, ui, openScreen, metaById, go, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// Handover of the sample build (MILESTONE-2 M2-10): the MS Manager persona picks a person of the ISMS, sees the open
// items that person holds there per kind, and moves the ticked kinds or everything to a successor; the warnings per
// record follow the move, and the built-in screens show the new owner. A document shared with other systems asks for
// the BR-22 confirmation first, readable in both themes. @sample-only: the API project covers the screen in
// e2e/api-only/handover.spec.js.
const meta = metaById('handover');
const dialog = (page) => ui.modal(page);
const person = (page) => page.locator('main select').first();
const successor = (page) => page.locator('main select').nth(1);
const kinds = (page) => page.locator('main section', { hasText: 'Open items per kind' }).locator('tbody tr');

test.describe('Handover @sample-only', () => {
  test('moves the ticked kinds, then everything, to a successor', async ({ page }) => {
    await openScreen(page, meta);
    await expect(page.locator('main')).toContainText('Choose the person whose open items you want to hand over.');
    await person(page).selectOption('bagus');
    await expect(page.locator('main')).toContainText('Open items of Bagus Prasetyo in ISMS');
    await expect(kinds(page).filter({ hasText: 'Risks' })).toContainText('1');
    await expect(kinds(page).filter({ hasText: 'Evidence' })).toContainText('27');
    const moveAll = page.locator('main button', { hasText: 'Move all items' });
    await expect(moveAll).toBeDisabled();
    await expect(page.locator('main')).toContainText('Choose a successor first.');
    await successor(page).selectOption('dewi');
    await expect(page.locator('main')).toContainText('Choose at least one kind to move.');
    await kinds(page).filter({ hasText: 'Risks' }).getByRole('checkbox').check();
    await kinds(page).filter({ hasText: 'Evidence' }).getByRole('checkbox').check();
    await page.locator('main button', { hasText: 'Move the chosen kinds' }).click();
    await expect(dialog(page)).toContainText('Move Evidence, Risks of Bagus Prasetyo in ISMS to Dewi Anggraini?');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expectToast(page, '28 items moved from Bagus Prasetyo to Dewi Anggraini');
    await expect(kinds(page).filter({ hasText: 'Evidence' })).toHaveCount(0);
    await expect(kinds(page).filter({ hasText: 'Risks' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    await moveAll.click();
    await expect(dialog(page)).toContainText(/Move all \d+ open items of Bagus Prasetyo in ISMS to Dewi Anggraini\?/);
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expect(page.locator('main')).toContainText('Nothing to hand over');
    await expect(page.locator('main')).toContainText('Bagus Prasetyo holds no open items in ISMS.');

    // The register follows: a document Bagus owned now belongs to Dewi.
    await go(page, 'Document register');
    await expect(page.locator('main')).not.toContainText('Bagus Prasetyo');
  });

  test('a person who is not listed is found by the typed user name; a name that cannot be a user name is refused', async ({ page }) => {
    await openScreen(page, meta);
    const typed = page.locator('main [data-typed-holder]');
    await typed.locator('input[name="holderHandle"]').fill('Bagus P');
    await typed.locator('button', { hasText: 'Show items' }).click();
    await expect(typed).toContainText('Type a user name: lower-case letters, digits, dots, dashes or underscores, starting with a letter.');
    // Without anyone listed apart, the picker has no groups.
    await expect(person(page).locator('optgroup')).toHaveCount(0);
    await typed.locator('input[name="holderHandle"]').fill('wulan');
    await typed.locator('button', { hasText: 'Show items' }).click();
    await expect(person(page)).toHaveValue('wulan');
    await expect(person(page).locator('optgroup[data-group="former"] option[value="wulan"]')).toHaveCount(1);
    await expect(page.locator('main')).toContainText('wulan is not an active member with a role in this organisation.');
    await expect(page.locator('main')).toContainText('The open items could not be loaded.');
    await expect(page.locator('main')).toContainText('wulan is not a member of this organisation');
    await expectReadableText(page, 4.5);
    await typed.locator('input[name="holderHandle"]').fill(' Bagus ');
    await typed.locator('button', { hasText: 'Show items' }).click();
    await expect(person(page)).toHaveValue('bagus');
    await expect(page.locator('main')).toContainText('Open items of Bagus Prasetyo in ISMS');
    await expect(page.locator('main')).not.toContainText('is not an active member');
  });

  for (const theme of ['light', 'dark']) {
    test(`a document shared with other systems asks for the BR-22 confirmation first, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `theme=${theme}`);
      await person(page).selectOption('hendra');
      await expect(page.locator('main')).toContainText('Open items of Hendra Wijaya in ISMS');
      await expect(page.locator('main')).toContainText('IMS-04');
      await successor(page).selectOption('dewi');
      await page.locator('main button', { hasText: 'Move all items' }).click();
      await expect(dialog(page)).toContainText(/Move all \d+ open items of Hendra Wijaya in ISMS to Dewi Anggraini\?/);
      await dialog(page).locator('button', { hasText: /^Move$/ }).click();
      await expect(dialog(page)).toContainText('Shared records change in other systems too');
      await expect(dialog(page)).toContainText('This change also applies to: ABMS, BCMS, QMS. Continue?');
      await expectOverlayReadable(page);
      await dialog(page).locator('button', { hasText: 'Move anyway' }).click();
      await expectToast(page, /items moved from Hendra Wijaya to Dewi Anggraini/);
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator('main')).toContainText('Hendra Wijaya holds no open items in ISMS.');
    });

    test(`readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await person(page).selectOption('bagus');
      await expect(page.locator('main')).toContainText('Item terbuka Bagus Prasetyo di ISMS');
      await successor(page).selectOption('dewi');
      await expectReadableText(page, 4.5);
      await page.locator('main button', { hasText: 'Pindahkan semua item' }).click();
      await expect(dialog(page)).toContainText('Serahkan item');
      await expectOverlayReadable(page);
    });
  }
});
