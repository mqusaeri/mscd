import { test, expect, ui, openApp, expectToast, expectOverlayReadable } from '../helpers.js';
import { DEMO_PASSWORD } from '../../e2e-api/fixtures.js';

// My account against the api (MILESTONE-2 M2-16): `GET /me/security`, the password change (a wrong current password
// stays in the dialog and the session goes on), new recovery codes (the test session proved its second factor when it
// started, so no code is needed), the preferences saved with `PUT /me/preferences` and applied at once and at the next
// start, the re-enrolment page, the calendar feed, and the drawer of a session without a system.
const entry = (page) => page.locator('header button[data-topbar="account"]');
const dialog = (page) => ui.modal(page);

async function post(page, path, body) {
  const me = await (await page.request.get('/api/v1/me')).json();
  return page.request.post(path, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, origin: new URL(page.url()).origin } });
}

test.describe('My account against the api @api-only', () => {
  test('shows the account and changes the password; a wrong current password keeps the session', async ({ page }) => {
    await openApp(page);
    await entry(page).click();
    await expect(ui.title(page)).toHaveText('My account');
    const main = page.locator('main');
    for (const text of ['Rina Kusuma', 'rina.kusuma@nusantaradigital.co.id', 'PT Nusantara Digital Teknologi', 'Test or demo session', 'Set up on']) await expect(main).toContainText(text);
    await expect(main).toContainText(/\d+ of 10 left/);
    await main.locator('button', { hasText: 'Change password' }).click();
    const fields = dialog(page).locator('input[type="password"]');
    await fields.nth(0).fill('Not-The-Password-2026');
    await fields.nth(1).fill('Mscd-Changed-Passphrase-2026');
    await fields.nth(2).fill('Mscd-Changed-Passphrase-2026');
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('The current password is not correct.');
    await expectOverlayReadable(page);
    expect((await page.request.get('/api/v1/me')).status()).toBe(200);
    await expect(ui.title(page)).toHaveText('My account');
    await fields.nth(0).fill(DEMO_PASSWORD);
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expectToast(page, 'Password changed. Your other sessions were signed out.');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('gets ten new recovery codes once and the count goes back to 10', async ({ page }) => {
    await openApp(page);
    await entry(page).click();
    await page.locator('main button', { hasText: 'Get new recovery codes' }).click();
    await dialog(page).locator('button', { hasText: 'Get new codes' }).click();
    const codes = dialog(page).locator('[data-recovery-codes] ul li');
    await expect(codes).toHaveCount(10);
    await expect(codes.first()).toHaveText(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
    await expectOverlayReadable(page);
    await dialog(page).locator('label', { hasText: 'I have saved these codes' }).click();
    await dialog(page).locator('button', { hasText: /^Done$/ }).click();
    await expect(page.locator('main')).toContainText('10 of 10 left');
  });

  test('preferences apply at once and again at the next start', async ({ page }) => {
    await openApp(page);
    await entry(page).click();
    const card = page.locator('main section', { hasText: 'Preferences' });
    await card.locator('select').nth(0).selectOption('id');
    await card.locator('select').nth(1).selectOption('dark');
    await card.locator('select').nth(2).selectOption('dense');
    await card.locator('button', { hasText: 'Save preferences' }).click();
    await expectToast(page, 'Preferensi disimpan');
    const root = page.locator('.mscd').first();
    await expect(ui.title(page)).toHaveText('Akun saya');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(root).toHaveAttribute('data-density', 'dense');
    const me = await (await page.request.get('/api/v1/me')).json();
    expect(me.preferences).toMatchObject({ language: 'id', theme: 'dark', density: 'dense' });
    await page.goto('/');
    await expect(ui.title(page)).toHaveText('Ikhtisar Portofolio');
    await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.mscd').first()).toHaveAttribute('data-density', 'dense');
  });

  test('Replace authenticator opens the re-enrolment page; a calendar feed is revoked', async ({ page }) => {
    await openApp(page);
    expect((await post(page, '/api/v1/ms/isms/calendar-feed')).status()).toBe(201);
    await entry(page).click();
    await page.locator('main li', { hasText: 'ISMS' }).locator('button', { hasText: 'Revoke calendar feed' }).click();
    await expect(ui.toast(page)).toBeVisible();
    await page.locator('main button', { hasText: 'Replace authenticator' }).click();
    await expect(page).toHaveURL(/\/login\/enrol/);
    await expect(page.getByText('Replace your authenticator')).toBeVisible();
  });

  test.describe('without a system', () => {
    test.use({ apiSession: 'tenant.admin' });
    test('a Tenant Admin without a business role gets the account in a drawer', async ({ page }) => {
      await page.goto('/');
      await expect(ui.title(page)).toBeVisible();
      await entry(page).click();
      const drawer = ui.drawer(page);
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('My account');
      await expect(drawer).toContainText('tenant.admin@mscd.test');
      await expect(drawer.locator('button', { hasText: 'Change password' })).toBeVisible();
      await expectOverlayReadable(page);
    });
  });
});
