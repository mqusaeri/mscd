import {
  test, expect, ui, openScreen, metaById, go, switchMs, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow,
} from '../helpers.js';

// Personal data checks of the sample build (MILESTONE-3 M3-04, D.6.4), as rina: the checks of each system, the records
// that name the person with a link to the screen that edits them, "Mark checked" with a note, the link to Handover, and
// an erasure of a person without an account answered once every system is checked. @sample-only: the API project
// covers the screen in e2e/api-only/privacy-checks.spec.js.
const meta = metaById('privacy-checks');
const requests = metaById('privacy-requests');
const dialog = (page) => ui.modal(page);
const drawer = (page) => ui.drawer(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

/** Marks the open check of Bima Haryanto's request in the selected system. */
async function markBima(page, note) {
  await rows(page).filter({ hasText: 'Bima Haryanto' }).click();
  await button(drawer(page), 'Mark checked').click();
  await dialog(page).locator('textarea').fill(note);
  await button(dialog(page), 'Mark checked').click();
  await expectToast(page, /The check of PR-\d{4}-002 is done/);
  await page.locator('div[style*="z-index: 40"]').click({ position: { x: 20, y: 450 } });
}

test.describe('Personal data checks @sample-only', () => {
  test('lists the checks of the system, shows the records that name the person and marks the check done', async ({ page }) => {
    await openScreen(page, meta);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText('To check');
    await expect(rows(page).last()).toContainText(/Done/);
    await expectNoHorizontalOverflow(page);
    await expectReadableText(page, 4.5);
    await rows(page).filter({ hasText: 'Bima Haryanto' }).click();
    await expect(drawer(page)).toContainText('Records that name the person');
    await expect(drawer(page).locator('table tbody tr')).toHaveCount(2);
    await expect(drawer(page)).toContainText('R-031');
    await expect(drawer(page)).not.toContainText('Open Handover');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Mark checked').click();
    await expect(dialog(page)).toContainText('What you checked and changed');
    await button(dialog(page), 'Mark checked').click();
    await expect(dialog(page)).toContainText('Fill in this field.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea').fill('Risk R-031 edited to name the contractor only');
    await button(dialog(page), 'Mark checked').click();
    await expectToast(page, /The check of PR-\d{4}-002 is done/);
    await expect(drawer(page).locator('.mx-reason')).toHaveText('This check is already done.');
    // The risk opens in Registers.
    await drawer(page).locator('table tbody tr', { hasText: 'R-031' }).locator('button', { hasText: /^Open$/ }).click();
    await expect(ui.title(page)).toHaveText('Registers');
  });

  test('every system checked: the erasure of a person without an account is answered', async ({ page }) => {
    await openScreen(page, meta);
    await markBima(page, 'Risk R-031 edited');
    for (const system of ['QMS', 'BCMS', 'ABMS']) {
      await switchMs(page, system);
      await expect(ui.title(page)).toHaveText('Personal data checks');
      await markBima(page, `Nothing found in the ${system}`);
    }
    await go(page, requests.label[0]);
    await page.locator('main table tbody tr', { hasText: 'Bima Haryanto' }).click();
    await expect(drawer(page).locator('table tbody tr', { hasText: 'Done' })).toHaveCount(4);
    await button(drawer(page), 'Start work').click();
    await dialog(page).locator('textarea').fill('Letter from the supplier with a signed identity card copy');
    await button(dialog(page), 'Start work').click();
    await expectToast(page, /Work on PR-\d{4}-002 started/);
    await button(drawer(page), 'Erase the person').click();
    await expect(dialog(page)).toContainText('The person has no account.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Erase the person').click();
    await expectToast(page, /The person of PR-\d{4}-002 is erased in this organisation/);
    await button(drawer(page), 'Close with the answer').click();
    await dialog(page).locator('textarea').fill('Records edited in every system; answered by letter');
    await button(dialog(page), 'Close with the answer').click();
    await expectToast(page, /Request PR-\d{4}-002 completed/);
    await expect(drawer(page)).toContainText('Person erased');
  });

  test('the Indonesian screen links to Handover for a member', async ({ page }) => {
    await openScreen(page, meta, 'lang=id');
    await expect(ui.title(page)).toHaveText('Pemeriksaan data pribadi');
    await rows(page).filter({ hasText: 'Selesai' }).click();
    await expect(drawer(page)).toContainText('Item terbuka orang tersebut');
    await expectOverlayReadable(page);
    await button(drawer(page), 'Buka Serah terima').click();
    await expect(ui.title(page)).toHaveText('Serah terima');
  });
});
