import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Personal data requests of the sample build (MILESTONE-3 M3-04, D.6), as rina, Tenant Admin of the sample
// organisation: the register with the time left, "Record request" with its checks, a member's request to stop using
// their data answered from start to close, the copy of a member's data, a refusal, a correction of a member's account,
// a withdrawal, the request drawer with its system checks, and the Indonesian screen in both themes. @sample-only: the API project covers the screen in
// e2e/api-only/privacy-requests.spec.js.
const meta = metaById('privacy-requests');
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

/** Fills the one text area of the open form and presses its button. */
async function submitText(page, text, label) {
  await dialog(page).locator('textarea').fill(text);
  await button(dialog(page), label).click();
}

test.describe('Personal data requests @sample-only', () => {
  test('shows the register and records a member\'s request, answered from start to close', async ({ page }) => {
    await openScreen(page, meta);
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).first()).toContainText('Bima Haryanto');
    await expect(rows(page).first()).toContainText(/\d+ h left/);
    await expect(rows(page).last()).toContainText(/Answered/);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    await ui.pageAction(page, 'Record request').click();
    await expect(dialog(page)).toContainText('Record a personal data request');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record').click();
    await expect(dialog(page)).toContainText('Choose the member.');
    await dialog(page).locator('select').first().selectOption('restriction');
    await dialog(page).locator('input[type="search"]').fill('fajar');
    await dialog(page).locator('[role="option"]', { hasText: 'Fajar Nugroho' }).click();
    await dialog(page).locator('select').nth(1).selectOption('letter');
    await button(dialog(page), 'Record').click();
    await expectToast(page, /Request PR-\d{4}-004 recorded/);
    await expect(drawer(page)).toContainText(/Request PR-\d{4}-004/);
    await expect(drawer(page)).toContainText('Fajar Nugroho');
    await expect(drawer(page)).toContainText('This type of request needs no system check.');
    await expect(drawer(page).locator('[data-actions] .mx-reason').first()).toHaveText('Start work first.');
    await inBothThemes(page, () => expectOverlayReadable(page));

    await button(drawer(page), 'Start work').click();
    await expect(dialog(page)).toContainText('How you checked who is asking');
    await button(dialog(page), 'Start work').click();
    await expect(dialog(page)).toContainText('Fill in this field.');
    await submitText(page, 'Letter signed and posted from the address the organisation knows', 'Start work');
    await expectToast(page, /Work on PR-\d{4}-004 started/);
    await expect(drawer(page)).toContainText('In progress');

    await button(drawer(page), 'Stop using the data').click();
    await expect(dialog(page)).toContainText('The membership is disabled');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Stop using the data').click();
    await expectToast(page, /The membership of PR-\d{4}-004 is disabled/);
    await expect(drawer(page)).toContainText('Membership disabled');

    await button(drawer(page), 'Close with the answer').click();
    await submitText(page, 'Membership disabled; answered by letter', 'Close with the answer');
    await expectToast(page, /Request PR-\d{4}-004 completed/);
    await expect(drawer(page)).toContainText('Completed');
    await expect(drawer(page)).toContainText('Membership disabled; answered by letter');
    await expect(button(drawer(page), 'Start work')).toHaveCount(0);
  });

  test('prepares a copy of a member\'s data; closing waits for the system checks', async ({ page }) => {
    await openScreen(page, meta);
    await rows(page).filter({ hasText: 'Copy of data' }).click();
    await expect(drawer(page)).toContainText('System checks');
    await expect(drawer(page).locator('table tbody tr')).toHaveCount(4);
    await expect(drawer(page)).toContainText('Two records checked; nothing to change');
    await expect(drawer(page).locator('[data-actions]')).toContainText('Wait until every system check is done.');
    await button(drawer(page), 'Prepare a copy of the data').click();
    await expectToast(page, 'The copy is being prepared.');
    await button(drawer(page), 'Download the copy').click();
    await expectToast(page, 'The sample build shows how this works');
    await button(drawer(page), 'Add note').click();
    await expect(dialog(page)).toContainText(/Note on PR-\d{4}-\d{3}/);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await submitText(page, 'Called the person to say the copy is coming', 'Add note');
    await expectToast(page, 'Note added');
    await expect(drawer(page)).toContainText('Called the person to say the copy is coming');
  });

  test('refuses a request of a person without an account; erasing waits for the checks', async ({ page }) => {
    await openScreen(page, meta);
    await rows(page).filter({ hasText: 'Bima Haryanto' }).click();
    await expect(drawer(page)).toContainText('No account in this organisation');
    await button(drawer(page), 'Start work').click();
    await submitText(page, 'Letter from the supplier with a signed identity card copy', 'Start work');
    await expectToast(page, /Work on PR-\d{4}-002 started/);
    await expect(drawer(page).locator('[data-actions]')).toContainText('Wait until every system check is done.');
    await button(drawer(page), 'Refuse').click();
    await expect(dialog(page)).toContainText('Reason');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await submitText(page, 'The supplier contract requires us to keep these records', 'Refuse');
    await expectToast(page, /Request PR-\d{4}-002 refused/);
    await expect(drawer(page)).toContainText('Refused');
    await page.locator('div[style*="z-index: 40"]').click({ position: { x: 20, y: 450 } });
    await page.locator('main select').first().selectOption('open');
    await expect(rows(page)).toHaveCount(1);
  });

  test('corrects the account of a member and records the withdrawal of another request, each form readable in both themes', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Record request').click();
    await dialog(page).locator('select').first().selectOption('rectification');
    await dialog(page).locator('input[type="search"]').fill('fajar');
    await dialog(page).locator('[role="option"]', { hasText: 'Fajar Nugroho' }).click();
    await dialog(page).locator('select').nth(1).selectOption('email');
    await button(dialog(page), 'Record').click();
    await expectToast(page, /Request PR-\d{4}-004 recorded/);
    await button(drawer(page), 'Start work').click();
    await submitText(page, 'Asked from the work email address the organisation knows', 'Start work');
    await expectToast(page, /Work on PR-\d{4}-004 started/);
    await button(drawer(page), 'Correct name or job title').click();
    await expect(dialog(page)).toContainText(/Correct the account of PR-\d{4}-004/);
    await expect(dialog(page)).toContainText('Only an account that belongs to this organisation alone can be corrected here.');
    await expect(dialog(page).locator('input[type="text"]').first()).toHaveValue('Fajar Nugroho');
    await dialog(page).locator('input[type="text"]').nth(1).fill('Senior Analyst');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Correct name or job title').click();
    await expectToast(page, /The account of PR-\d{4}-004 is corrected/);
    await button(drawer(page), 'Close with the answer').click();
    await expect(dialog(page)).toContainText(/Close PR-\d{4}-004/);
    await dialog(page).locator('textarea').fill('Job title corrected as asked');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close with the answer').click();
    await expectToast(page, /Request PR-\d{4}-004 completed/);

    await page.locator('div[style*="z-index: 40"]').click({ position: { x: 20, y: 450 } });
    await rows(page).filter({ hasText: 'Copy of data' }).click();
    await button(drawer(page), 'Record withdrawal').click();
    await expect(dialog(page)).toContainText(/Record that the person withdrew PR-\d{4}-001/);
    await dialog(page).locator('textarea').fill('The person withdrew the request by phone');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record withdrawal').click();
    await expectToast(page, /Withdrawal of PR-\d{4}-001 recorded/);
    await expect(drawer(page)).toContainText('Withdrawn');
  });

  for (const theme of ['light', 'dark']) {
    test(`the Indonesian screen and its forms are readable, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(ui.title(page)).toHaveText('Permintaan data pribadi');
      await expect(rows(page)).toHaveCount(3);
      await expectReadableText(page, 4.5);
      await ui.pageAction(page, 'Catat permintaan').click();
      await expect(dialog(page)).toContainText('Catat permintaan data pribadi');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await rows(page).filter({ hasText: 'Salinan data' }).click();
      await expect(drawer(page)).toContainText('Pemeriksaan sistem');
      await expectOverlayReadable(page);
    });
  }
});
