import {
  test, expect, ui, go, openApp, openScreen, metaById, openRow, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow,
  expectNoTextOverflow,
} from '../helpers.js';

// Policy read confirmations of the sample build (MILESTONE-3 M3-05, D.7): the Management System Manager reads the
// requests of the ISMS with their totals, opens POL-01 with its person list, reminds the pending people once a day,
// downloads the register as CSV and closes the request into an evidence item; asks for confirmation of POL-14 from the
// page action; and sets the read confirmation of a document in its detail. Top Management sees totals only (product
// decision 2). Every drawer and dialog is readable in both themes. @sample-only: the API project covers the screen in
// e2e/api-only/acknowledgements.spec.js.
const meta = metaById('acknowledgements');
const body = (page) => page.locator('main [data-screen="acknowledgements"]');
const row = (page, code) => body(page).locator('tbody tr', { hasText: code });
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page).last();
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Policy read confirmations @sample-only', () => {
  test('the manager reads, reminds, downloads and closes a request into an evidence item', async ({ page }) => {
    await openScreen(page, meta);
    await expect(ui.title(page)).toHaveText('Policy read confirmations');
    await expect(row(page, 'POL-01')).toContainText('Open');
    await expect(row(page, 'POL-14')).toContainText('Closed');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    await row(page, 'POL-01').click();
    await expect(drawer(page)).toContainText('POL-01 version 4.0');
    await expect(drawer(page)).toContainText('Everyone with a role in the document\'s systems');
    await expect(drawer(page).locator('[data-person="bagus"]')).toHaveText('Bagus Prasetyo');
    await expect(drawer(page).locator('tbody tr', { hasText: 'Bagus Prasetyo' })).toContainText('Confirmed');
    const pending = Number(await drawer(page).locator('[data-stat="pending"] [data-value]').getAttribute('data-value'));
    expect(pending).toBeGreaterThan(0);
    await inBothThemes(page, () => expectOverlayReadable(page));

    await button(drawer(page), 'Remind').click();
    await expectToast(page, `Reminded ${pending === 1 ? '1 person' : `${pending} people`} to confirm POL-01`);
    await button(drawer(page), 'Remind').click();
    await expect(drawer(page).locator('[role="alert"]')).toContainText('reminded today already');

    const download = page.waitForEvent('download');
    await button(drawer(page), 'Export CSV').click();
    expect((await download).suggestedFilename()).toBe('read-confirmations-POL-01-v4.0-2026-09-29.csv');

    await button(drawer(page), 'Close and file as evidence').click();
    await expect(dialog(page)).toContainText('Close the request of POL-01');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close and file').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Choose an evidence item, or close without filing.');
    await dialog(page).locator('[role="option"]').first().click();
    const evidence = (await dialog(page).locator('[role="option"][aria-selected="true"] .mx-mono').innerText()).trim();
    await button(dialog(page), 'Close and file').click();
    await expectToast(page, `Request closed. The register is filed as a new file of ${evidence}.`);
    await expect(drawer(page)).toContainText('This request is closed. Reminders stopped.');
    await expect(drawer(page)).toContainText(evidence);
    await expect(button(drawer(page), 'Remind')).toHaveCount(0);
  });

  test('"Ask for confirmation" sends a request to the chosen roles and refuses an incomplete one', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Ask for confirmation').click();
    await expect(dialog(page)).toContainText('The people you choose get a task and a notification');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Send the request').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose a document.');
    await dialog(page).locator('select[name="document"]').selectOption('POL-01');
    await button(dialog(page), 'Send the request').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('This version already has an open confirmation request.');
    await dialog(page).locator('select[name="document"]').selectOption('POL-14');
    await dialog(page).getByLabel('Only the roles I choose').check();
    await button(dialog(page), 'Send the request').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose at least one role.');
    await dialog(page).getByLabel('Top Management').check();
    await dialog(page).locator('input[name="dueDays"]').fill('7');
    await button(dialog(page), 'Send the request').click();
    await expectToast(page, 'Asked 1 person to confirm POL-14 version 1.0');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(row(page, 'POL-14').first()).toContainText('Open');
    await expect(row(page, 'POL-14').first()).toContainText('0 of 1');
    await expect(row(page, 'POL-14').first()).toContainText('6 Oct 2026');
  });

  test('a document\'s detail shows its read confirmation, and the settings change in a dialog', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await openRow(page, 'POL-01');
    const section = drawer(page).locator('[data-read-confirmation="POL-01"]');
    await expect(section).toContainText('Read confirmation');
    await expect(section.locator('[data-setting]')).toHaveText('Each new approved version is sent for read confirmation: Everyone with a role in the document\'s systems, 14 days.');
    await expect(section.locator('[data-latest]')).toContainText(/^Version 4\.0: \d+ of \d+ confirmed/);
    await button(section, 'Read confirmation settings').click();
    await expect(dialog(page)).toContainText('Read confirmation of POL-01');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Only the roles I choose').check();
    await button(dialog(page), 'Save').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose at least one role.');
    await dialog(page).getByLabel('Domain Owner').check();
    await dialog(page).locator('input[name="dueDays"]').fill('21');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Read confirmation of POL-01 saved');
    await expect(section.locator('[data-setting]')).toHaveText('Each new approved version is sent for read confirmation: Holders of: Domain Owner, 21 days.');
    await button(section, 'Open read confirmations').click();
    await expect(ui.title(page)).toHaveText('Policy read confirmations');
    await expect(drawer(page)).toContainText('POL-01 version 4.0');
  });

  test('Top Management sees the totals of each request and no names or actions', async ({ page }) => {
    await page.goto('/?screen=acknowledgements&persona=top');
    await expect(ui.title(page)).toHaveText('Policy read confirmations');
    await expect(body(page)).toContainText('You see the totals of each request.');
    await expect(ui.pageAction(page, 'Ask for confirmation')).toHaveCount(0);
    await row(page, 'POL-01').click();
    await expect(drawer(page).locator('[data-stat="confirmed"]')).toBeVisible();
    await expect(drawer(page).locator('[data-person]')).toHaveCount(0);
    await expect(button(drawer(page), 'Remind')).toHaveCount(0);
    await expect(button(drawer(page), 'Export CSV')).toHaveCount(0);
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});
