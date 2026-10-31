import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Access review of this system in the sample build (MILESTONE-3 M3-07, D.9), as rina, the only Management System
// Manager of the ISMS: the ISMS part of the open review with its business roles and the guest auditor, rina's own role
// that needs a second reviewer, a decision refused nowhere because her own row has no action, the guest grant decided
// "revoke" and revoked with "Revoke guest access", "Sign off" disabled while items wait and then signed off with the
// A.5.18 evidence item proposed, an earlier review chosen read-only, and the Indonesian screen. @sample-only: the API
// project covers the screen in e2e/api-only/access-review.spec.js.
const meta = metaById('access-review');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const card = (page, title) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: new RegExp(title) }) });
const rows = (scope) => scope.locator('table tbody tr');
/** The rows of a person, found by the name in the person column (a "granted by" or "decided by" mention does not count). */
const personRows = (scope, name) => rows(scope).filter({ has: scope.page().locator('td strong[data-person]', { hasText: new RegExp(`^${name}$`) }) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Access review of this system @sample-only', () => {
  test('decides the ISMS items, revokes the guest grant and signs off into the A.5.18 evidence', async ({ page }) => {
    await openScreen(page, meta);
    await expect(page).toHaveURL(/access-review\?ms=isms/);
    const head = card(page, /^ISMS in access review AR-\d{4}-03/);
    await expect(head).toBeVisible();
    await expect(page.locator('main')).toContainText('concern the only reviewer of this system');
    const items = card(page, '^Business roles and guest auditors');
    const own = personRows(items, 'Rina Kusuma').filter({ hasText: 'Management System Manager' });
    await expect(own).toContainText('Needs a second reviewer');
    await expect(own.locator('button')).toHaveCount(0);
    // A business role names who asked for it and, under the four-eyes flow, who approved it.
    await expect(own).toContainText(/Requested by \S/);
    await expect(items).toContainText(/Approved by \S/);
    await expect(button(head, 'Sign off')).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    // The guest auditor: revoke, then "Revoke guest access".
    const guest = personRows(items, 'Eko Santoso');
    await button(guest, 'Decide').click();
    await expect(dialog(page)).toContainText('Decide on the access of Eko Santoso');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await dialog(page).locator('textarea[name="note"]').fill('The certification audit ended');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    await button(guest, 'Revoke guest access').click();
    await expectToast(page, 'Guest access revoked; the auditor was signed out');
    await expect(guest).toContainText('Applied');

    // Every other item: keep, through the selection.
    await items.locator('select[name="decided"]').selectOption('undecided');
    await items.getByLabel('Select every item shown').check();
    await button(items, /Decide for \d+ selected/.source).click();
    await dialog(page).getByLabel('Keep: the access is still needed').check();
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, /Decision saved for \d+ item\(s\)/);
    await expect(rows(items)).toHaveCount(1);
    await expect(rows(items)).toContainText('Needs a second reviewer');

    await button(head, 'Sign off').click();
    await expect(dialog(page)).toContainText(/Sign off ISMS in access review AR-\d{4}-03/);
    await expect(dialog(page)).toContainText('covers control A.5.18 (access rights) and is proposed.');
    await expect(dialog(page)).toContainText('1 item(s) stay without a decision');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Sign off').click();
    await expectToast(page, /ISMS signed off; its rows are filed to EV-\d+ when the review completes/);
    await expect(head).toContainText('Signed off');
    await expect(button(head, 'Sign off')).toHaveCount(0);
  });

  test('shows an earlier review read-only and the screen in Indonesian', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main select[name="review"]').selectOption({ index: 1 });
    const head = card(page, /^ISMS in access review AR-\d{4}-02/);
    await expect(head).toContainText('Signed off');
    await expect(head).toContainText('EV-');
    const items = card(page, '^Business roles and guest auditors');
    await expect(personRows(items, 'Eko Santoso')).toContainText('Applied');
    await expect(items.locator('input[type="checkbox"]')).toHaveCount(0);

    await openScreen(page, meta, 'lang=id');
    await expect(page.locator('main h1')).toHaveText('Tinjauan akses sistem ini');
    await expect(card(page, '^Peran bisnis dan auditor tamu')).toContainText('Memerlukan peninjau kedua');
    await expectReadableText(page, 4.5);
  });
});
