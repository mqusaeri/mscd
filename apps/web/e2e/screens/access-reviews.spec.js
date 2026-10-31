import { readFile } from 'node:fs/promises';
import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Access reviews of the sample build (MILESTONE-3 M3-07, D.9), as rina, one of the two Tenant Admins of the sample
// organisation: the open review (opened by the schedule five days ago) and the completed one of the last quarter, the
// schedule with "Change schedule", the review page with its organisation items, rina's own items (decided by tono, no
// checkbox), a decision for a selection and a revocation applied from "Revocations and changes to apply", "Not applied"
// and "Mark as applied", "Complete" disabled with what still waits, the report as CSV, "Cancel review", and the
// Indonesian screen. @sample-only: the API project covers the screen in e2e/api-only/access-reviews.spec.js.
const meta = metaById('access-reviews');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const card = (page, title) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: new RegExp(`^${title}`) }) });
const rows = (scope) => scope.locator('table tbody tr');
/** The rows of a person, found by the name in the person column (a "granted by" or "decided by" mention does not count). */
const personRows = (scope, name) => rows(scope).filter({ has: scope.page().locator('td strong[data-person]', { hasText: new RegExp(`^${name}$`) }) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openReview(page) {
  await openScreen(page, meta);
  await button(card(page, 'Open review'), 'Open review').click();
  await expect(page.locator('main [data-review]')).toBeVisible();
  await expect(card(page, 'Organisation access')).toBeVisible();
}

test.describe('Access reviews @sample-only', () => {
  test('shows the open review, the schedule and every review; the schedule changes with its checks', async ({ page }) => {
    await openScreen(page, meta);
    const open = card(page, 'Open review');
    await expect(open).toContainText(/AR-\d{4}-03 is open and due on/);
    await expect(open).toContainText('by the schedule');
    await expect(rows(card(page, 'All reviews'))).toHaveCount(2);
    await expect(card(page, 'All reviews')).toContainText('Completed');
    await expect(card(page, 'Schedule')).toContainText('Every 3 months');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    await button(card(page, 'Schedule'), 'Change schedule').click();
    await expect(dialog(page)).toContainText('Access review schedule');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="daysToComplete"]').fill('90');
    await button(dialog(page), 'Save schedule').click();
    await expect(dialog(page)).toContainText('Enter a number of days from 1 to 60.');
    await dialog(page).locator('select[name="frequencyMonths"]').selectOption('6');
    await dialog(page).locator('input[name="daysToComplete"]').fill('21');
    await button(dialog(page), 'Save schedule').click();
    await expectToast(page, 'Schedule saved');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Schedule')).toContainText('Every 6 months');
    await expect(card(page, 'Schedule')).toContainText('21 days');
  });

  test('decides a selection, revokes a linked sign-in and applies it; rina\'s own items wait for another Tenant Admin', async ({ page }) => {
    await openReview(page);
    const org = card(page, 'Organisation access');
    const own = personRows(org, 'Rina Kusuma').first();
    await expect(own).toContainText('You');
    await expect(own).toContainText('by Tono');
    await expect(own.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(button(org.locator('.mx-card-head'), 'Decide')).toBeDisabled();
    await expect(org).toContainText('Select at least one item first.');

    await org.locator('select[name="decided"]').selectOption('undecided');
    const first = rows(org).nth(0);
    const second = rows(org).nth(1);
    await first.locator('input[type="checkbox"]').check();
    await second.locator('input[type="checkbox"]').check();
    await button(org, 'Decide for 2 selected').click();
    await expect(dialog(page)).toContainText('Decide on 2 item(s)');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save decision').click();
    await expect(dialog(page)).toContainText('Choose a decision.');
    await dialog(page).getByLabel('Change: keep it with a change, for example a shorter end date').check();
    await button(dialog(page), 'Save decision').click();
    await expect(dialog(page)).toContainText('Say what changes.');
    await dialog(page).getByLabel('Keep: the access is still needed').check();
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 2 item(s)');
    await expect(dialog(page)).toHaveCount(0);

    // The linked company sign-in of bagus: revoke, then apply it.
    await org.locator('select[name="decided"]').selectOption('');
    await org.locator('select[name="kind"]').selectOption('linked_sign_in');
    const linked = personRows(org, 'Bagus Prasetyo');
    await button(linked, 'Decide').click();
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await dialog(page).locator('textarea[name="note"]').fill('Signs in with the password only');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    const apply = card(page, 'Revocations and changes to apply');
    const waiting = personRows(apply, 'Bagus Prasetyo');
    await expect(waiting).toContainText('Signs in with the password only');
    await button(waiting, 'Not applied').click();
    await expect(dialog(page)).toContainText('Not applied: keycloak of Bagus Prasetyo');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Cancel').click();
    await button(waiting, 'Mark as applied').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Cancel').click();
    await button(waiting, 'Apply').click();
    await expectToast(page, 'Linked sign-in removed');
    await expect(personRows(apply, 'Bagus Prasetyo')).toHaveCount(0);
    await expect(personRows(org, 'Bagus Prasetyo')).toContainText('Applied');
    // A decision applied is locked.
    await expect(button(personRows(org, 'Bagus Prasetyo'), 'Change decision')).toHaveCount(0);
  });

  test('cannot complete while something waits, downloads the report and cancels the review with a reason', async ({ page }) => {
    await openReview(page);
    const head = page.locator('main [data-review] section.mx-card').first();
    await expect(button(head, 'Complete')).toBeDisabled();
    await expect(head).toContainText('Not everything is done yet; see the list below.');
    await expect(head.locator('[data-complete-waits]')).toContainText('Not signed off yet: ISMS');
    await expect(head.locator('[data-complete-waits]')).toContainText('organisation item(s) to decide');
    const [download] = await Promise.all([page.waitForEvent('download'), button(head, 'Download report').click()]);
    expect(download.suggestedFilename()).toMatch(/^access-review-AR-\d{4}-03\.csv$/);
    const text = await readFile(await download.path(), 'utf8');
    expect(text.split(/\r\n/)[0]).toBe('review_no,opened_on,due_on,system,item_kind,person,handle,role,requested_by,approved_by,decision,decision_note,decided_by,decided_at,applied_action,applied_by,applied_at,not_applied_reason');

    await expect(card(page, 'Systems')).toContainText('ISMS');
    await button(head, 'Cancel review').click();
    await expect(dialog(page)).toContainText(/Cancel access review AR-\d{4}-03/);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Cancel review').click();
    await expect(dialog(page)).toContainText('Enter a reason.');
    await dialog(page).locator('textarea[name="reason"]').fill('Opened before the reorganisation; a new one follows');
    await button(dialog(page), 'Cancel review').click();
    await expectToast(page, /Access review AR-\d{4}-03 cancelled/);
    await expect(head).toContainText('Cancelled');
    await expect(head).toContainText('Opened before the reorganisation');
    await button(page.locator('main'), 'Back to access reviews').click();
    await expect(card(page, 'Open review')).toContainText('No access review is open');
    await button(card(page, 'Open review'), 'Start review now').click();
    await expectToast(page, /Access review AR-\d{4}-\d{2} started with \d+ item\(s\) to review/);
    await expect(page.locator('main [data-review]')).toBeVisible();
  });

  test('shows the screen in Indonesian', async ({ page }) => {
    await openScreen(page, meta, 'lang=id');
    await expect(page.locator('main h1')).toHaveText('Tinjauan akses');
    await expect(card(page, 'Tinjauan terbuka')).toContainText('oleh jadwal');
    await expect(card(page, 'Jadwal')).toContainText('Setiap 3 bulan');
    await button(card(page, 'Tinjauan terbuka'), 'Buka tinjauan').click();
    await expect(card(page, 'Akses organisasi')).toContainText('Keanggotaan aktif');
    await expectReadableText(page, 4.5);
  });
});
