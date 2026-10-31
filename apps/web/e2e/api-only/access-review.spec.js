import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Access review of this system against the api (MILESTONE-3 M3-07, D.9). tenant.admin starts a review of the Test
// Organisation; rina, the only Management System Manager of its ISMS, sees the ISMS part with the filters, her own role
// that needs a second reviewer (no action on it, and the api refuses it with REVIEW-OWN-ACCESS), "Sign off" disabled
// with its reason while items wait, decides every other item through the selection, keeps the guest grant with a change
// that she marks as applied, and signs off without an evidence item. Every form is readable in both themes. Before any
// review, the screen says that none exists yet.
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const card = (page, title) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: new RegExp(title) }) });
const rows = (scope) => scope.locator('table tbody tr');
const personRows = (scope, name) => rows(scope).filter({ has: scope.page().locator('td strong[data-person]', { hasText: new RegExp(`^${name}$`) }) });

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function apiCall(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  return page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() } });
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Access review of this system against the api @api-only', () => {
  test.use({ apiSession: null });

  test('rina reviews the ISMS part: filters, her own role left for a second reviewer, a change marked as applied and the sign-off', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Access review of this system');
    await expect(page.locator('main')).toContainText('No access review of this system yet');

    await signIn(page, baseURL, 'tenant.admin', 'tst');
    const started = await apiCall(page, baseURL, 'POST', '/api/v1/admin/access-reviews', {});
    expect(started.status(), await started.text()).toBe(201);
    const reviewId = (await started.json()).data.id;

    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Access review of this system');
    const head = card(page, '^ISMS in access review AR-2026-01');
    await expect(head).toBeVisible();
    await expect(button(head, 'Sign off')).toBeDisabled();
    await expect(head).toContainText('Decide every item first');
    await expectReadableText(page, 4.5);
    const items = card(page, '^Business roles and guest auditors');
    await items.locator('select[name="kind"]').selectOption('auditor_access');
    await expect(rows(items)).toHaveCount(1);
    await items.locator('select[name="kind"]').selectOption('');

    // Her own role: no action here, refused by the api.
    const own = personRows(items, 'Rina Kusuma').filter({ hasText: 'Management System Manager' });
    await expect(own).toContainText('Needs a second reviewer');
    await expect(own.locator('button')).toHaveCount(0);
    const part = await (await page.request.get(`${baseURL}/api/v1/ms/isms/access-reviews/${reviewId}`)).json();
    const ownItem = part.rows.find((r) => r.ownAccess);
    const refused = await apiCall(page, baseURL, 'POST', `/api/v1/ms/isms/access-reviews/${reviewId}/items/${ownItem.id}/decision`, { decision: 'keep' });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).rule).toBe('REVIEW-OWN-ACCESS');

    // The guest grant is kept with a shorter end date, marked as applied.
    const guest = personRows(items, 'Eko Santoso');
    await button(guest, 'Decide').click();
    await dialog(page).getByLabel('Change: keep it with a change, for example a shorter end date').check();
    await dialog(page).locator('textarea[name="note"]').fill('End the grant on the last audit day');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    await button(guest, 'Mark as applied').click();
    await expect(dialog(page)).toContainText('Mark as applied: External Auditor of Eko Santoso');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="note"]').fill('End date changed on Auditor access');
    await button(dialog(page), 'Mark as applied').click();
    await expectToast(page, 'Marked as applied');
    await expect(guest).toContainText('End date changed on Auditor access');

    // Every other item through the selection, then the sign-off without an evidence item.
    await items.locator('select[name="decided"]').selectOption('undecided');
    await items.getByLabel('Select every item shown').check();
    await items.locator('.mx-card-head button', { hasText: /^Decide for \d+ selected$/ }).click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Keep: the access is still needed').check();
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, /Decision saved for \d+ item\(s\)/);
    await button(head, 'Sign off').click();
    await expect(dialog(page)).toContainText('1 item(s) stay without a decision');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Choose none').click();
    await expect(dialog(page)).toContainText('No evidence item chosen: the rows of this system are not filed.');
    await button(dialog(page), 'Sign off').click();
    await expectToast(page, /^ISMS signed off/);
    await expect(head).toContainText('Signed off');
    const after = await (await page.request.get(`${baseURL}/api/v1/ms/isms/access-reviews/${reviewId}`)).json();
    expect(after).toMatchObject({ status: 'signed_off', signedOffBy: { handle: 'rina' } });
  });
});
