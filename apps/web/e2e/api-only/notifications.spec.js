import { test, expect, ui, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// The notification bell against the api (MILESTONE-2 M2-16): rina reminds every holder of an open ISMS chain item
// (`POST /reminders/bulk`), which gives bagus in-app notifications; bagus sees the unread count in the top bar, opens
// the panel, marks one or all read (`POST /notifications/{id}/read`, `POST /notifications/read-all`) and opens a
// record. A session without an organisation has no bell (e2e/api-only/ops.spec.js).
const bell = (page) => page.locator('header button[data-topbar="notifications"]');
const count = (page) => bell(page).locator('.mx-topbtn-count');
const panel = (page) => ui.drawer(page);

async function remindEveryone(page, baseURL) {
  const me = await (await page.request.get(baseURL + '/api/v1/me')).json();
  const res = await page.request.post(baseURL + '/api/v1/reminders/bulk', { data: { ms: 'isms', scope: 'open_chain_items' }, headers: { 'X-CSRF-Token': me.csrfToken, origin: baseURL } });
  expect(res.ok()).toBe(true);
  // A session of bagus in the same browser context.
  const session = await page.request.post(baseURL + '/api/v1/test/session', { data: { handle: 'bagus' }, headers: { origin: baseURL } });
  expect(session.ok()).toBe(true);
}

test.describe('Notifications against the api @api-only', () => {
  test('the unread count, the panel, Mark all read and Open', async ({ page, baseURL }) => {
    await remindEveryone(page, baseURL);
    await openApp(page);
    await expect(count(page)).toHaveText(/^\d+$/);
    expect(Number(await count(page).innerText())).toBeGreaterThan(0);
    await bell(page).click();
    await expect(panel(page)).toContainText('Notifications');
    await expect(panel(page).locator('li[data-unread]').first()).toContainText('Reminder');
    await expectOverlayReadable(page);
    await panel(page).locator('button', { hasText: 'Mark all read' }).click();
    await expectToast(page, 'Every notification is marked read');
    await expect(panel(page).locator('li[data-unread]')).toHaveCount(0);
    await expect(count(page)).toHaveCount(0);
    await expect(panel(page).locator('button', { hasText: 'Mark all read' })).toBeDisabled();
    expect((await (await page.request.get(baseURL + '/api/v1/notifications?unread=true&pageSize=1')).json()).total).toBe(0);
    await panel(page).locator('li[data-notification] button', { hasText: /^Open$/ }).first().click();
    await expect(panel(page)).toHaveCount(0);
    await expect(ui.title(page)).not.toHaveText('Portfolio Overview');
  });

  test('Mark read marks one notification read', async ({ page, baseURL }) => {
    await remindEveryone(page, baseURL);
    await openApp(page);
    const unread = async () => (await (await page.request.get(baseURL + '/api/v1/notifications?unread=true&pageSize=1')).json()).total;
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    await bell(page).click();
    const first = panel(page).locator('li[data-unread]').first();
    const id = await first.getAttribute('data-notification');
    await first.locator('button', { hasText: 'Mark read' }).click();
    await expect(panel(page).locator(`li[data-notification="${id}"]`)).not.toHaveAttribute('data-unread', '');
    await expect.poll(unread).toBe(before - 1);
    if (before > 1) await expect(count(page)).toHaveText(String(before - 1));
    else await expect(count(page)).toHaveCount(0);
  });

  test('Open on an unread notification marks it read and the count follows', async ({ page, baseURL }) => {
    await remindEveryone(page, baseURL);
    await openApp(page);
    const unread = async () => (await (await page.request.get(baseURL + '/api/v1/notifications?unread=true&pageSize=1')).json()).total;
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    await expect(count(page)).toHaveText(String(before));
    await bell(page).click();
    // The bell reads the count after the Mark read of "Open" is answered, not at the same time.
    await panel(page).locator('li[data-unread]').first().locator('button', { hasText: /^Open$/ }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(unread).toBe(before - 1);
    if (before > 1) await expect(count(page)).toHaveText(String(before - 1));
    else await expect(count(page)).toHaveCount(0);
  });

  test('the panel is readable in Indonesian and dark theme, and the filter shows the empty picture', async ({ page, baseURL }) => {
    await remindEveryone(page, baseURL);
    await openApp(page, '?lang=id&theme=dark');
    await expect(bell(page)).toHaveAttribute('title', 'Notifikasi');
    await bell(page).click();
    await expect(panel(page)).toContainText('Tandai semua dibaca');
    await expectOverlayReadable(page);
    await panel(page).locator('button', { hasText: 'Tandai semua dibaca' }).click();
    await panel(page).locator('label', { hasText: 'Tampilkan yang belum dibaca saja' }).click();
    await expect(panel(page)).toContainText('Semua sudah Anda baca');
    await expect(panel(page).locator('svg[data-scene="all-done"]')).toBeVisible();
  });
});
