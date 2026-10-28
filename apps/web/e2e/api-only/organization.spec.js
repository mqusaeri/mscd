import { test, expect, ui, go, openApp, expectToast } from '../helpers.js';

// The Organisation screen against the api (MILESTONE-2 M2-16): `GET /admin/organization` and `PATCH` with `If-Match`
// for rina, Tenant Admin of PT Nusantara Digital Teknologi. A change made elsewhere after the screen loaded answers
// 412; the screen keeps the form and loads the settings again on request. The Licence screen shows the same
// installation id; Top Management reads the licence without it.
const card = (page) => page.locator('main section', { hasText: 'Organisation settings' });
const sites = (page) => card(page).locator('input[type="number"]');

async function patchOrganization(page, body) {
  const me = await (await page.request.get('/api/v1/me')).json();
  const read = await page.request.get('/api/v1/admin/organization');
  const etag = (await read.json()).etag;
  const res = await page.request.patch('/api/v1/admin/organization', {
    data: body,
    headers: { 'X-CSRF-Token': me.csrfToken, 'If-Match': etag, origin: new URL(page.url()).origin },
  });
  expect(res.status()).toBe(204);
}

test.describe('Organisation against the api @api-only', () => {
  test('shows the settings and the permanent slug, saves a change and keeps it', async ({ page }) => {
    await openApp(page);
    await go(page, 'Organisation');
    await expect(card(page).locator('input').first()).toHaveValue('PT Nusantara Digital Teknologi');
    await expect(card(page)).toContainText('Slug');
    await expect(card(page).locator('input[disabled]')).toHaveValue('ndt (cannot be changed)');
    await expect(page.locator('main')).toContainText('One organisation on this installation');
    const id = await page.locator('main [data-installation-id]').getAttribute('data-installation-id');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await sites(page).fill('5');
    await card(page).locator('select').selectOption('Asia/Makassar');
    await card(page).locator('button', { hasText: 'Save changes' }).click();
    await expectToast(page, 'Organisation settings saved');
    await page.reload();
    await go(page, 'Organisation');
    await expect(sites(page)).toHaveValue('5');
    await expect(card(page).locator('select')).toHaveValue('Asia/Makassar');
    // Nothing changed: nothing is sent.
    await card(page).locator('button', { hasText: 'Save changes' }).click();
    await expect(card(page)).toContainText('Nothing changed.');
  });

  test('a change made elsewhere first answers 412; Load again shows it', async ({ page }) => {
    await openApp(page);
    await go(page, 'Organisation');
    await expect(sites(page)).toBeVisible();
    await patchOrganization(page, { name: 'PT Nusantara Digital Teknologi Tbk' });
    await sites(page).fill('9');
    await card(page).locator('button', { hasText: 'Save changes' }).click();
    await expect(card(page)).toContainText('Someone else changed these settings after you opened them.');
    await card(page).locator('button', { hasText: 'Load again' }).click();
    await expect(card(page).locator('input').first()).toHaveValue('PT Nusantara Digital Teknologi Tbk');
  });

  test('an empty name is refused before anything is sent; Copy copies the installation id', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await go(page, 'Organisation');
    await card(page).locator('input').first().fill(' ');
    await card(page).locator('button', { hasText: 'Save changes' }).click();
    await expect(card(page).locator('[role="alert"]')).toHaveText('Enter the name of the organisation.');
    await page.locator('main section', { hasText: 'Installation id' }).locator('button', { hasText: 'Copy' }).click();
    await expectToast(page, 'Installation id copied');
    const id = await page.locator('main [data-installation-id]').getAttribute('data-installation-id');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    await go(page, 'Licence');
    await expect(page.locator('main [data-installation-id]')).toHaveAttribute('data-installation-id', id);
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('the Licence shows no installation id and Organisation is not in the sidebar', async ({ page }) => {
      await openApp(page);
      await expect(ui.nav(page, 'Organisation')).toHaveCount(0);
      await go(page, 'Licence');
      await expect(page.locator('main')).toContainText('LIC-DEMO-NDT');
      await expect(page.locator('main [data-installation-id]')).toHaveCount(0);
    });
  });
});
