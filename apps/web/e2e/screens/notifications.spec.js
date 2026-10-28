import { test, expect, ui, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// The notification bell of the sample build (MILESTONE-2 M2-16): the unread count in the top bar, the panel with Mark
// read, Mark all read, the unread filter and Open to the record. @sample-only: the API project covers the bell in
// e2e/api-only/notifications.spec.js.
const bell = (page) => page.locator('header button[data-topbar="notifications"]');
const count = (page) => bell(page).locator('.mx-topbtn-count');
const panel = (page) => ui.drawer(page);

test.describe('Notifications @sample-only', () => {
  test('the bell shows the unread count on every screen and opens the panel', async ({ page }) => {
    await openApp(page);
    await expect(bell(page)).toHaveAttribute('title', 'Notifications');
    await expect(count(page)).toHaveText('3');
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('Notifications');
    await expect(panel(page).locator('li[data-notification]')).toHaveCount(4);
    await expect(panel(page).locator('li[data-unread]')).toHaveCount(3);
    await expect(panel(page)).toContainText('Reminder from Rina Kusuma');
    await expect(panel(page)).toContainText('Licence ends in 6 months');
    await expectOverlayReadable(page);
  });

  test('Mark read and Mark all read lower the count; the unread filter shows the all caught up picture', async ({ page }) => {
    await openApp(page);
    await bell(page).click();
    await panel(page).locator('li[data-unread]').first().locator('button', { hasText: 'Mark read' }).click();
    await expect(panel(page).locator('li[data-unread]')).toHaveCount(2);
    await expect(count(page)).toHaveText('2');
    await panel(page).locator('button', { hasText: 'Mark all read' }).click();
    await expectToast(page, 'Every notification is marked read');
    await expect(panel(page).locator('li[data-unread]')).toHaveCount(0);
    await expect(count(page)).toHaveCount(0);
    await expect(panel(page).locator('button', { hasText: 'Mark all read' })).toBeDisabled();
    await panel(page).locator('label', { hasText: 'Show unread only' }).click();
    await expect(panel(page)).toContainText('You are all caught up');
    await expect(panel(page).locator('svg[data-scene="all-done"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
  });

  test('Open goes to the record of the notification', async ({ page }) => {
    await openApp(page);
    await bell(page).click();
    const reminder = panel(page).locator('li[data-notification="sample-n1"]');
    const text = await reminder.innerText();
    const code = /Rina Kusuma: (\S+)/.exec(text)[1];
    await reminder.locator('button', { hasText: /^Open$/ }).click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.drawer(page)).toBeVisible();
    await expect(ui.drawer(page)).toContainText(code);
    await expect(count(page)).toHaveText('2');
  });

  for (const theme of ['light', 'dark']) {
    test(`the panel is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openApp(page, `?lang=id&theme=${theme}`);
      await expect(bell(page)).toHaveAttribute('title', 'Notifikasi');
      await page.waitForTimeout(1300);
      await expectReadableText(page, 4.5);
      await bell(page).click();
      await expect(panel(page)).toContainText('Tandai semua dibaca');
      await expect(panel(page)).toContainText('Pengingat');
      await expectOverlayReadable(page);
    });
  }
});
