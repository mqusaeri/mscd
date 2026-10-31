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

// My data against the api (MILESTONE-3 M3-04, D.6.6): "Download my data" queues the export of one's own data (the test
// stack runs no worker, so it stays prepared), "Correct my name and job title" saves through `PATCH /me/profile`, and
// "Ask the organisation" files a request the Tenant Admins see in Personal data requests, one open request per type.
test.describe('My data against the api @api-only', () => {
  const card = (page) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: /^My data$/ }) });

  async function inBothThemes(page, check) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
      await check();
    }
  }

  test('queues a copy, corrects the name and asks the organisation, which the Tenant Admin sees', async ({ page }) => {
    await openApp(page);
    await entry(page).click();
    await expect(card(page)).toContainText('You have not asked the organisation about your data.');
    await card(page).locator('button', { hasText: 'Download my data' }).click();
    await expect(card(page)).toContainText('Your copy is being prepared.');
    await card(page).locator('button', { hasText: 'Check again' }).click();
    await expect(card(page)).toContainText('Your copy is being prepared.');

    await card(page).locator('button', { hasText: 'Correct my name and job title' }).click();
    await expect(dialog(page).locator('input').first()).toHaveValue('Rina Kusuma');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input').first().fill('Rina Kusuma Dewi');
    await dialog(page).locator('input').nth(1).fill('Information Security Manager');
    await dialog(page).locator('button', { hasText: 'Save correction' }).click();
    await expectToast(page, 'Your name and job title are saved');
    await expect(page.locator('main section.mx-card').first()).toContainText('Rina Kusuma Dewi');
    const me = await (await page.request.get('/api/v1/me')).json();
    expect(me.user).toMatchObject({ displayName: 'Rina Kusuma Dewi', jobTitle: 'Information Security Manager' });

    await card(page).locator('button', { hasText: 'Ask the organisation' }).click();
    await dialog(page).locator('label', { hasText: 'Correct data that is wrong' }).click();
    await dialog(page).locator('textarea').fill('My employee number on the access card list is wrong');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('button', { hasText: 'Send request' }).click();
    await expectToast(page, /Request PR-\d{4}-\d{3} sent/);
    const row = card(page).locator('table tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Correction');
    await expect(row).toContainText('Received');
    const requestNo = (await row.locator('td').first().innerText()).trim();
    await card(page).locator('button', { hasText: 'Ask the organisation' }).click();
    await dialog(page).locator('label', { hasText: 'Correct data that is wrong' }).click();
    await dialog(page).locator('button', { hasText: 'Send request' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toBeVisible();
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');

    // rina is also a Tenant Admin: the request is in Personal data requests, received through My account.
    await page.locator('aside nav button[title="Personal data requests"]').click();
    await expect(ui.title(page)).toHaveText('Personal data requests');
    await page.locator('main table tbody tr', { hasText: requestNo }).click();
    await expect(ui.drawer(page)).toContainText('My account');
    await expect(ui.drawer(page)).toContainText('My employee number on the access card list is wrong');
  });
});
