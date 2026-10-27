import { test, expect, ui, go, HOST_METAS } from '../helpers.js';

// The administration landing (MILESTONE-2 C.3): a Tenant Admin without a business role (tenant.admin of the Test
// Organisation) gets the shell with the Administration group, lands on the first administration screen it may open
// ("Getting started" once M2-16 exists, else Licence) and has no management system to switch to.
async function firstAdminLabel(page, lang = 0) {
  const me = await (await page.request.get('/api/v1/me')).json();
  const held = me.permissions.org || [];
  const meta = HOST_METAS.find((m) => m.group === 'admin' && m.nav !== false && m.scope !== 'ms' && (Array.isArray(m.perm) ? m.perm : [m.perm]).some((p) => held.includes(p)));
  return meta.label[lang];
}

test.describe('Administration landing @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('a Tenant Admin without a business role lands in the Administration group without a system switcher', async ({ page }) => {
    await page.goto('/');
    await expect(ui.title(page)).toHaveText(await firstAdminLabel(page));
    await expect(page.locator('main')).toContainText('Administration');
    await expect(ui.msSwitch(page)).toHaveCount(0);
    await expect(page.locator('header')).toContainText('Tenant Admin');
    for (const label of ['Framework library', 'Storage repositories', 'Licence']) await expect(ui.nav(page, label)).toHaveCount(1);
    for (const label of ['Portfolio Overview', 'Overview', 'Controls & requirements', 'Document register', 'My Tasks']) await expect(ui.nav(page, label)).toHaveCount(0);
  });

  test('the administration screens open, Licence shows the Test Organisation licence, and the language switch keeps the screen', async ({ page }) => {
    await page.goto('/');
    await expect(ui.title(page)).toHaveText(await firstAdminLabel(page));
    await go(page, 'Storage repositories');
    await go(page, 'Framework library');
    await go(page, 'Licence');
    await expect(page.locator('main')).toContainText('LIC-DEMO-TST');
    await expect(ui.pageAction(page, 'Install licence')).toBeVisible();
    await page.locator('header button', { hasText: /^ID$/ }).click();
    await expect(ui.title(page)).toHaveText('Lisensi');
    await expect(page.locator('header')).toContainText('Admin Tenant');
  });
});
