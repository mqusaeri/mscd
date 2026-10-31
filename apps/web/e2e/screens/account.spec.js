import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, pageSettled } from '../helpers.js';

// My account of the sample build (MILESTONE-2 M2-16): opened from the top bar, with the password, recovery codes,
// company sign-in, calendar feeds and preferences applied at once. @sample-only: the API project covers the screen in
// e2e/api-only/account.spec.js.
const meta = metaById('account');
const dialog = (page) => ui.modal(page);
const entry = (page) => page.locator('header button[data-topbar="account"]');

test.describe('My account @sample-only', () => {
  test('opens from the top bar for every persona and shows the account', async ({ page }) => {
    await page.goto('/');
    await expect(entry(page)).toHaveAttribute('title', 'My account');
    await entry(page).click();
    await expect(ui.title(page)).toHaveText('My account');
    const main = page.locator('main');
    await expect(main.locator('[data-screen="account"]')).toBeVisible();
    for (const text of ['Rina Kusuma', 'rina.kusuma@nusantaradigital.co.id', 'Set up on 3 Feb 2026', '8 of 10 left', 'Sign in with Microsoft', 'Revoke calendar feed']) {
      await expect(main).toContainText(text);
    }
    // No sidebar entry.
    await expect(ui.nav(page, 'My account')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectReadableText(page, 4.5);
    await page.goto('/?persona=owner');
    await entry(page).click();
    await expect(ui.title(page)).toHaveText('My account');
    await expect(page.locator('main')).toContainText('Bagus Prasetyo');
  });

  test('Change password checks the form, keeps a wrong current password in the dialog and saves', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main button', { hasText: 'Change password' }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expect(dialog(page)).toContainText('Enter your current password.');
    await expect(dialog(page)).toContainText('The new password needs at least 12 characters.');
    const fields = dialog(page).locator('input[type="password"]');
    await fields.nth(0).fill('old password');
    await fields.nth(1).fill('a much longer passphrase');
    await fields.nth(2).fill('another passphrase');
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expect(dialog(page)).toContainText('The two new passwords are not the same.');
    await expectOverlayReadable(page);
    await fields.nth(2).fill('a much longer passphrase');
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expectToast(page, 'Password changed. Your other sessions were signed out.');
    await expect(dialog(page)).toHaveCount(0);
    // The sample now knows the new password: an old one is refused in the dialog.
    await page.locator('main button', { hasText: 'Change password' }).click();
    await fields.nth(0).fill('old password');
    await fields.nth(1).fill('yet another long passphrase');
    await fields.nth(2).fill('yet another long passphrase');
    await dialog(page).locator('button', { hasText: /^Change password$/ }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('The current password is not correct.');
  });

  test('new recovery codes need the current code, show once with Copy and Download, and Done after the confirmation', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main button', { hasText: 'Get new recovery codes' }).click();
    await dialog(page).locator('button', { hasText: 'Get new codes' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Enter the current code from your authenticator app.');
    await dialog(page).locator('input').fill('492039');
    await dialog(page).locator('button', { hasText: 'Get new codes' }).click();
    const codes = dialog(page).locator('[data-recovery-codes] ul li');
    await expect(codes).toHaveCount(10);
    await expect(codes.first()).toHaveText(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
    await expectOverlayReadable(page);
    const download = page.waitForEvent('download');
    await dialog(page).locator('button', { hasText: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('mscd-recovery-codes.txt');
    const done = dialog(page).locator('button', { hasText: /^Done$/ });
    await expect(done).toBeDisabled();
    await dialog(page).locator('label', { hasText: 'I have saved these codes' }).click();
    await done.click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('main')).toContainText('10 of 10 left');
  });

  test('preferences apply at once: language, theme and density', async ({ page }) => {
    await openScreen(page, meta);
    const root = page.locator('.mscd').first();
    const card = page.locator('main section', { hasText: 'Preferences' });
    const selects = card.locator('select');
    await selects.nth(0).selectOption('id');
    await selects.nth(1).selectOption('dark');
    await selects.nth(2).selectOption('dense');
    await card.locator('button', { hasText: 'Save preferences' }).click();
    await expectToast(page, 'Preferensi disimpan');
    await expect(ui.title(page)).toHaveText('Akun saya');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(root).toHaveAttribute('data-density', 'dense');
    await pageSettled(page);
    await expectReadableText(page, 4.5);
  });

  test('Replace authenticator says where it works, and a calendar feed is revoked', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main button', { hasText: 'Replace authenticator' }).click();
    await expect(page.locator('main')).toContainText('The sample build has no sign-in pages.');
    await page.locator('main button', { hasText: 'Revoke calendar feed' }).first().click();
    await expectToast(page, 'Calendar feed revoked');
    await page.locator('main button', { hasText: /^Link$/ }).click();
    await expect(page.locator('main')).toContainText('The sample build has no company sign-in.');
  });

  for (const theme of ['light', 'dark']) {
    test(`the dialogs are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(ui.title(page)).toHaveText('Akun saya');
      await page.locator('main button', { hasText: 'Ubah kata sandi' }).click();
      await expect(dialog(page)).toContainText('Kata sandi saat ini');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await page.locator('main button', { hasText: 'Dapatkan kode pemulihan baru' }).click();
      await expect(dialog(page)).toContainText('Kode dari aplikasi autentikator Anda');
      await expectOverlayReadable(page);
    });
  }
});
