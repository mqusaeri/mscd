import {
  test, expect, ui, go, openApp, openScreen, metaById, openRow, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow,
  expectNoTextOverflow,
} from '../helpers.js';

// Policy read confirmations of the sample build (MILESTONE-3 M3-05, D.7): the Management System Manager reads the
// requests of the ISMS with their totals, opens POL-01 with its person list, reminds the pending people once a day,
// downloads the register as CSV and closes the request into an evidence item, then asks the people who have not
// confirmed (M3-14); asks for confirmation from the page action, where people who confirmed the version already are not
// asked again (M3-14); and sets the read confirmation of a document in its detail. The page says who is asked, and the
// person list shows the day each person was added with their own due date (a newcomer joined POL-01 after its start).
// Top Management sees totals only (product decision 2). Every drawer and dialog is readable in both themes.
// @sample-only: the API project covers the screen in e2e/api-only/acknowledgements.spec.js.
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
    await expect(body(page).locator('[data-audience-note]')).toContainText('Who is asked: MSCD users with a business role in the document\'s systems.');
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
    const excused = Number(await drawer(page).locator('[data-stat="excused"] [data-value]').getAttribute('data-value'));
    const confirmed = Number(await drawer(page).locator('[data-stat="confirmed"] [data-value]').getAttribute('data-value'));
    expect(confirmed).toBeGreaterThan(0);
    // Newcomers (M3-14): the day each person was added and their own due date; one person joined three days after the start.
    await expect(drawer(page).locator('[data-newcomers-note]')).toContainText('added to it the next morning, with their own due date');
    await expect(drawer(page).locator('thead')).toContainText('Added on');
    await expect(drawer(page).locator('[data-added="2026-09-19"]').first()).toBeVisible();
    await expect(drawer(page).locator('[data-added="2026-09-22"]')).toHaveCount(1);
    await expect(drawer(page).locator('[data-due="2026-10-06"]')).toHaveCount(1);
    await expect(drawer(page).locator('[data-opened-note]')).toContainText('MSCD cannot see when the person read it');
    await expect(drawer(page).locator('[data-reason]')).toHaveText('No longer holds a role that is asked to confirm');
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

    // "Ask the people who have not confirmed" (M3-14): a new request of the same version for the people who did not confirm.
    await button(drawer(page), 'Ask the people who have not confirmed').click();
    await expect(dialog(page)).toContainText('People who already confirmed this version are not asked again.');
    await expect(dialog(page).locator('select[name="document"]')).toHaveValue('POL-01');
    await button(dialog(page), 'Send the request').click();
    const asked = pending + excused;
    await expectToast(page, `Asked ${asked === 1 ? '1 person' : `${asked} people`} to confirm POL-01 version 4.0`);
    await expect(row(page, 'POL-01').first()).toContainText('Open');
    await expect(row(page, 'POL-01').first()).toContainText(`0 of ${asked}`);

    // The register of the new request also lists the confirmations of the first one (M3-14), as the drawer and the
    // close dialog say; the close dialog proposes the evidence item of the first register again.
    await row(page, 'POL-01').first().click();
    await expect(drawer(page).locator('[data-earlier-note]')).toHaveText(
      `The register also lists the confirmations of version 4.0 from earlier requests (${confirmed}), so its file holds every confirmation of this version.`,
    );
    await button(drawer(page), 'Close and file as evidence').click();
    await expect(dialog(page).locator('[role="option"][aria-selected="true"] .mx-mono')).toHaveText(evidence);
    await expect(dialog(page).locator('[data-earlier-note]')).toContainText(`from earlier requests (${confirmed})`);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close and file').click();
    await expectToast(page, `Request closed. The register is filed as a new file of ${evidence}.`);
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
    // Top Management confirmed POL-14 version 1.0 in the closed request, so nobody is left to ask (M3-14).
    await button(dialog(page), 'Send the request').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Everyone this request would ask has confirmed this version already.');
    await dialog(page).locator('select[name="document"]').selectOption('STD-05');
    await button(dialog(page), 'Send the request').click();
    await expectToast(page, 'Asked 1 person to confirm STD-05 version 1.1');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(row(page, 'STD-05').first()).toContainText('Open');
    await expect(row(page, 'STD-05').first()).toContainText('0 of 1');
    await expect(row(page, 'STD-05').first()).toContainText('6 Oct 2026');
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
