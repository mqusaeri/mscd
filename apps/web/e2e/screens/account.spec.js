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

// My data (MILESTONE-3 M3-04, D.6.6) of the sample build: the copy made in the browser, the correction of name and job
// title, and the requests to the organisation with the rule of one open request per type.
test.describe('My data of My account @sample-only', () => {
  const card = (page) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: /^My data$/ }) });

  test('downloads a copy, corrects the name and asks the organisation', async ({ page }) => {
    await openScreen(page, meta);
    await expect(card(page)).toContainText('You have not asked the organisation about your data.');
    const download = page.waitForEvent('download');
    await card(page).locator('button', { hasText: 'Download my data' }).click();
    expect((await download).suggestedFilename()).toMatch(/^personal-data-rina\.kusuma-\d{4}-\d{2}-\d{2}\.json$/);
    await expectToast(page, 'Your data is downloaded');

    await card(page).locator('button', { hasText: 'Correct my name and job title' }).click();
    await expect(dialog(page)).toContainText('Correct your name and job title');
    await dialog(page).locator('input').first().fill('');
    await dialog(page).locator('button', { hasText: 'Save correction' }).click();
    await expect(dialog(page)).toContainText('Enter your name.');
    await expectOverlayReadable(page);
    await dialog(page).locator('input').first().fill('Rina K. Kusuma');
    await dialog(page).locator('button', { hasText: 'Save correction' }).click();
    await expectToast(page, 'Your name and job title are saved');
    await expect(page.locator('main section.mx-card').first()).toContainText('Rina K. Kusuma');

    await card(page).locator('button', { hasText: 'Ask the organisation' }).click();
    await expect(dialog(page)).toContainText('A Tenant Admin answers by the deadline your organisation set.');
    await dialog(page).locator('label', { hasText: 'Erase my data in this organisation' }).click();
    await dialog(page).locator('textarea').fill('I am leaving the company at the end of the month');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Send request' }).click();
    await expectToast(page, /Request PR-\d{4}-041 sent/);
    await expect(card(page).locator('table tbody tr')).toHaveCount(1);
    await expect(card(page)).toContainText('Erasure');
    await expect(card(page)).toContainText('Received');
    await card(page).locator('button', { hasText: 'Ask the organisation' }).click();
    await dialog(page).locator('label', { hasText: 'Erase my data in this organisation' }).click();
    await dialog(page).locator('button', { hasText: 'Send request' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('You already have an open request of this type.');
    await expectNoHorizontalOverflow(page);
  });

  for (const theme of ['light', 'dark']) {
    test(`the My data forms are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      const id = page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: /^Data saya$/ }) });
      await expect(id).toContainText('Permintaan saya');
      await id.locator('button', { hasText: 'Koreksi nama dan jabatan saya' }).click();
      await expect(dialog(page)).toContainText('Koreksi nama dan jabatan Anda');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await id.locator('button', { hasText: 'Minta kepada organisasi' }).click();
      await expect(dialog(page)).toContainText('Yang Anda minta');
      await expectOverlayReadable(page);
    });
  }
});
