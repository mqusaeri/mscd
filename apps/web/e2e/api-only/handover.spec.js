import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Handover against the api (MILESTONE-2 M2-10, `records.holdings` and `records.holdings.reassign`, H.13). rina, MS
// Manager of the ISMS in the Test Organisation, opens Handover from the revoke dialog of People and roles with bagus
// chosen, sees his open items per kind, moves his risks to dewi and then everything else; the rules run per record and
// their warnings are listed per record. A person who left still holds items: after bagus is disabled, or loses his
// last role, the snapshot no longer lists him among the people, and Handover lists him apart (or takes his typed user
// name), so rina can still move his items. People and roles loads the snapshot again after a Disable or Enable again
// (D2-08), so Handover, opened without a new page load, never offers a disabled member as a successor and offers a member
// enabled again. A Tenant Admin without a role in the system has no Handover.
const dialog = (page) => ui.modal(page);
const drawer = (page) => ui.drawer(page);
const kinds = (page) => page.locator('main section', { hasText: 'Open items per kind' }).locator('tbody tr');

const holderPicker = (page) => page.locator('main select[name="holder"]');
const typed = (page) => page.locator('main [data-typed-holder]');

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, {
    method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
  });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
}

async function memberId(page, baseURL, handle) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/users?pageSize=200`)).json();
  return list.items.find((u) => u.handle === handle).id;
}

const successorPicker = (page) => page.locator('main select').nth(1);

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('Handover against the api @api-only', () => {
  test.use({ apiSession: null });

  test('rina hands the open items of bagus over to dewi, the chosen kinds first, then everything', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'People and roles');
    await page.locator('main table tbody tr', { hasText: 'Bagus Prasetyo' }).click();
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await dialog(page).locator('button', { hasText: 'Open Handover' }).click();
    await expect(page.locator('main h1')).toHaveText('Handover');
    await expect(page.locator('main select').first()).toHaveValue('bagus');
    await expect(page.locator('main')).toContainText('Open items of Bagus Prasetyo in ISMS');
    await expect(kinds(page).filter({ hasText: 'Risks' })).toBeVisible();
    const risks = Number((await kinds(page).filter({ hasText: 'Risks' }).locator('td').last().innerText()).trim());
    expect(risks).toBeGreaterThan(0);
    await expect(page.locator('main table').last()).toContainText('R-014');

    await page.locator('main select').nth(1).selectOption('dewi');
    await kinds(page).filter({ hasText: 'Risks' }).getByRole('checkbox').check();
    await page.locator('main button', { hasText: 'Move the chosen kinds' }).click();
    await expect(dialog(page)).toContainText('Move Risks of Bagus Prasetyo in ISMS to Dewi Anggraini?');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expectToast(page, `${risks} items moved from bagus to dewi`);
    await expect(kinds(page).filter({ hasText: 'Risks' })).toHaveCount(0);

    await page.locator('main button', { hasText: 'Move all items' }).click();
    await expect(dialog(page)).toContainText(/Move all \d+ open items of Bagus Prasetyo in ISMS to Dewi Anggraini\?/);
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expectToast(page, /\d+ items moved from bagus to dewi/);
    await expect(page.locator('main')).toContainText('Nothing to hand over');
    // Warnings name the record they are about (BR-41 and BR-16 per record), when the rules found any.
    const warnings = page.locator('main [role="status"] li');
    for (const text of await warnings.allInnerTexts()) expect(text).toMatch(/^[A-Z0-9][\w.-]*: /);

    // dewi now holds the risks: the holdings of dewi list R-014.
    await page.locator('main select').first().selectOption('dewi');
    await expect(page.locator('main table').last()).toContainText('R-014');
  });

  test('after bagus is disabled, rina finds him under the former members and hands all his items over to dewi', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'People and roles');
    await page.locator('main table tbody tr', { hasText: 'Bagus Prasetyo' }).click();
    await drawer(page).locator('button', { hasText: /^Disable$/ }).click();
    await expect(dialog(page)).toContainText('After disabling, Handover lists the person under former members.');
    await dialog(page).getByLabel('Type bagus.prasetyo@nusantaradigital.co.id to confirm').fill('bagus.prasetyo@nusantaradigital.co.id');
    await dialog(page).locator('button', { hasText: /^Disable$/ }).click();
    await expectToast(page, 'Bagus Prasetyo is disabled');

    // People and roles loaded the snapshot again, which lists only active members with a role: Handover, opened
    // without a new page load, lists bagus apart, as he still holds his items.
    await go(page, 'Handover');
    await expect(holderPicker(page).locator('optgroup[data-group="former"]')).toHaveAttribute('label', 'Former members and people without a role');
    await expect(holderPicker(page).locator('optgroup[data-group="former"] option[value="bagus"]')).toHaveCount(1);
    await expect(holderPicker(page).locator('option[value="bagus"]')).toHaveCount(1);
    // He is not offered as a successor of another holder either.
    await holderPicker(page).selectOption('dewi');
    await expect(successorPicker(page).locator('option[value="rina"]')).toHaveCount(1);
    await expect(successorPicker(page).locator('option[value="bagus"]')).toHaveCount(0);
    await darkTheme(page);
    await holderPicker(page).selectOption('bagus');
    await expect(page.locator('main')).toContainText('bagus is not an active member with a role in this organisation. The open items can still be moved to a successor.');
    await expect(page.locator('main')).toContainText('Open items of bagus in ISMS');
    await expect(kinds(page).filter({ hasText: 'Risks' })).toBeVisible();
    await expectReadableText(page, 4.5);
    // The successor is chosen from the active members with a role only.
    await expect(successorPicker(page).locator('option[value="dewi"]')).toHaveCount(1);
    await expect(successorPicker(page).locator('option[value="bagus"]')).toHaveCount(0);
    await successorPicker(page).selectOption('dewi');
    await page.locator('main button', { hasText: 'Move all items' }).click();
    await expect(dialog(page)).toContainText(/Move all \d+ open items of bagus in ISMS to Dewi Anggraini\?/);
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expectToast(page, /\d+ items moved from bagus to dewi/);
    await expect(page.locator('main')).toContainText('Nothing to hand over');
    await expect(page.locator('main')).toContainText('bagus holds no open items in ISMS.');
  });

  test('after rina enables bagus again in People and roles, Handover offers him as a successor without a new page load', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'tst');
    await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/users/${await memberId(page, baseURL, 'bagus')}`, { membershipStatus: 'disabled' });
    await openApp(page);
    await go(page, 'Handover');
    await expect(holderPicker(page).locator('optgroup[data-group="former"] option[value="bagus"]')).toHaveCount(1);
    await holderPicker(page).selectOption('dewi');
    await expect(successorPicker(page).locator('option[value="rina"]')).toHaveCount(1);
    await expect(successorPicker(page).locator('option[value="bagus"]')).toHaveCount(0);

    await go(page, 'People and roles');
    await page.locator('main table tbody tr', { hasText: 'Bagus Prasetyo' }).click();
    await drawer(page).locator('button', { hasText: 'Enable again' }).click();
    await dialog(page).locator('button', { hasText: /^Enable$/ }).click();
    await expectToast(page, 'Bagus Prasetyo is active again');

    await go(page, 'Handover');
    await expect(holderPicker(page).locator('optgroup[data-group="former"] option[value="bagus"]')).toHaveCount(0);
    await expect(holderPicker(page).locator('option[value="bagus"]')).toHaveCount(1);
    await holderPicker(page).selectOption('dewi');
    await expect(successorPicker(page).locator('option[value="bagus"]')).toHaveCount(1);
  });

  test('after the last role of bagus is revoked, rina types his user name and moves his risks to dewi', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'People and roles');
    await page.locator('main table tbody tr', { hasText: 'Bagus Prasetyo' }).click();
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    await expectToast(page, 'Role revoked');

    await openApp(page);
    await go(page, 'Handover');
    // A typed name that cannot be a user name is refused on the screen; a user name nobody has is refused by the api.
    await typed(page).locator('input[name="holderHandle"]').fill('Bagus Prasetyo');
    await typed(page).locator('button', { hasText: 'Show items' }).click();
    await expect(typed(page)).toContainText('Type a user name: lower-case letters, digits, dots, dashes or underscores, starting with a letter.');
    await typed(page).locator('input[name="holderHandle"]').fill('nobody.here');
    await typed(page).locator('button', { hasText: 'Show items' }).click();
    await expect(page.locator('main')).toContainText('The open items could not be loaded.');
    await expect(page.locator('main')).toContainText('nobody.here is not a member of this organisation');
    await typed(page).locator('input[name="holderHandle"]').fill('bagus');
    await typed(page).locator('button', { hasText: 'Show items' }).click();
    await expect(holderPicker(page)).toHaveValue('bagus');
    await expect(page.locator('main')).toContainText('Open items of bagus in ISMS');
    const risks = Number((await kinds(page).filter({ hasText: 'Risks' }).locator('td').last().innerText()).trim());
    expect(risks).toBeGreaterThan(0);
    await page.locator('main select').nth(1).selectOption('dewi');
    await kinds(page).filter({ hasText: 'Risks' }).getByRole('checkbox').check();
    await page.locator('main button', { hasText: 'Move the chosen kinds' }).click();
    await expect(dialog(page)).toContainText('Move Risks of bagus in ISMS to Dewi Anggraini?');
    await dialog(page).locator('button', { hasText: /^Move$/ }).click();
    await expectToast(page, `${risks} items moved from bagus to dewi`);
    await expect(kinds(page).filter({ hasText: 'Risks' })).toHaveCount(0);
  });

  test('a Tenant Admin without a role in the system has no Handover', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await expect(ui.nav(page, 'Handover')).toHaveCount(0);
  });
});
