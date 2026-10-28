import { test, expect, ui, expectToast, expectOverlayReadable } from '../helpers.js';
import { DEMO_PASSWORD, demoCode, freshTotpStep } from '../../e2e-api/fixtures.js';

// The operator console against the api (MILESTONE-2 M2-16): the platform operator `ops` has no membership, so the test
// session endpoint cannot mint its session; it signs in with its password and authenticator code and lands on the
// first platform screen (C.3). The stack runs one organisation (single tenancy): health, jobs, diagnostics and the
// factor reset work; organisations, licences and packs belong to the installer and the Tenant Admin there, which the
// console says.
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });

async function signInAsOperator(page) {
  await freshTotpStep();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Work email').fill('ops@mscd.test');
  await page.locator('#au-password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByLabel('Authentication code').fill(demoCode('ops'));
  await expect(ui.title(page)).toHaveText('Operator console');
}

test.describe('Operator console against the api @api-only', () => {
  test.use({ apiSession: null });

  test('the operator lands on the console: health, diagnostics and a job run', async ({ page }) => {
    await signInAsOperator(page);
    await expect(page.locator('aside nav')).toContainText('Operator console');
    // No organisation: no notifications; the account opens in a drawer.
    await expect(page.locator('header button[data-topbar="notifications"]')).toHaveCount(0);
    await expect(page.locator('header button[data-topbar="account"]')).toBeVisible();
    // Single tenancy: no Create organisation.
    await expect(page.locator('main button[title="Create organisation"]')).toHaveCount(0);
    const main = page.locator('main');
    await expect(main.locator('table').first()).toContainText('database');
    await expect(main).toContainText('Up to date');
    const download = page.waitForEvent('download');
    await main.locator('button', { hasText: 'Download diagnostics' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.tar\.gz$/);
    await expectToast(page, 'Diagnostics archive downloaded');
    await tab(page, 'Jobs').click();
    await main.locator('select').selectOption('cleanup.expired');
    await main.locator('button', { hasText: 'Run job' }).click();
    await expectToast(page, 'Job cleanup.expired queued as');
  });

  test('organisations and packs say that one organisation runs here; the factor reset works', async ({ page }) => {
    await signInAsOperator(page);
    const main = page.locator('main');
    await tab(page, 'Organisations').click();
    await expect(main).toContainText('This installation runs one organisation (single tenancy).');
    await tab(page, 'Framework packs').click();
    await expect(main).toContainText('On an installation with one organisation, its administrator installs packs in the Framework library.');
    await tab(page, 'Accounts').click();
    await main.locator('input').fill('sari.wulandari@nusantaradigital.co.id');
    await main.locator('textarea').fill('Lost phone, identity checked by video call');
    await main.locator('button', { hasText: 'Reset factor' }).click();
    await expect(ui.modal(page)).toContainText('sari.wulandari@nusantaradigital.co.id');
    await expectOverlayReadable(page);
    await ui.modal(page).locator('button', { hasText: 'Reset factor' }).click();
    await expectToast(page, 'The sign-in factor of sari.wulandari@nusantaradigital.co.id was reset');
    await page.locator('header button[data-topbar="account"]').click();
    await expect(ui.drawer(page)).toContainText('ops@mscd.test');
    await expect(ui.drawer(page).locator('button', { hasText: 'Change password' })).toBeVisible();
  });
});
