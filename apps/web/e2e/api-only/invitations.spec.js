import { test, expect, ui, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// The invitation banner against the api (MILESTONE-2 M2-16, D.2): tenant.admin invites an existing account of
// another organisation to the Test Organisation (`POST /admin/users`), which gives that person an invited membership
// (`Me.pendingMemberships`). The banner of the host layer offers Accept (`POST /me/memberships/{org}/accept`),
// Decline after a confirmation (`.../decline`) and Later.
const banner = (page) => page.locator('section.mx-invite');

async function invite(page, baseURL, email, displayName, handle) {
  const admin = await page.request.post(baseURL + '/api/v1/test/session', { data: { handle: 'tenant.admin' }, headers: { origin: baseURL } });
  const me = await admin.json();
  const res = await page.request.post(baseURL + '/api/v1/admin/users', { data: { email, displayName, adminRoles: [] }, headers: { 'X-CSRF-Token': me.csrfToken, origin: baseURL } });
  expect(res.status()).toBe(202);
  const session = await page.request.post(baseURL + '/api/v1/test/session', { data: { handle }, headers: { origin: baseURL } });
  expect(session.ok()).toBe(true);
}

test.describe('Invitations against the api @api-only', () => {
  test.use({ apiSession: null });

  test('an invited person accepts and finds the organisation in the organisation menu', async ({ page, baseURL }) => {
    await invite(page, baseURL, 'sari.wulandari@nusantaradigital.co.id', 'Sari Wulandari', 'sari');
    await openApp(page);
    await expect(banner(page)).toContainText('You were invited to Test Organisation');
    await expect(banner(page)).toContainText('Invited by Tenant Admin on');
    await banner(page).locator('button', { hasText: /^Accept$/ }).click();
    await expectToast(page, 'You joined Test Organisation.');
    await expect(banner(page)).toHaveCount(0);
    const me = await (await page.request.get(baseURL + '/api/v1/me')).json();
    expect(me.pendingMemberships).toEqual([]);
    await ui.orgButton(page).click();
    await expect(page.locator('aside button', { hasText: 'Test Organisation' })).toBeVisible();
  });

  test('Decline asks first, then removes the invitation; Later only hides it until the next start', async ({ page, baseURL }) => {
    await invite(page, baseURL, 'tono.hartono@nusantaradigital.co.id', 'Tono Hartono', 'tono');
    await openApp(page);
    await expect(banner(page)).toContainText('You were invited to Test Organisation');
    await banner(page).locator('button', { hasText: 'Later' }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.reload();
    await expect(banner(page)).toContainText('You were invited to Test Organisation');
    await banner(page).locator('button', { hasText: /^Decline$/ }).click();
    await expect(ui.modal(page)).toContainText('You will not join Test Organisation.');
    await expectOverlayReadable(page);
    await ui.modal(page).locator('button', { hasText: /^Decline$/ }).click();
    await expectToast(page, 'Invitation to Test Organisation declined');
    await expect(banner(page)).toHaveCount(0);
    const me = await (await page.request.get(baseURL + '/api/v1/me')).json();
    expect(me.pendingMemberships).toEqual([]);
    await page.reload();
    await expect(ui.title(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test('the banner is readable in Indonesian, dark theme', async ({ page, baseURL }) => {
    await invite(page, baseURL, 'sari.wulandari@nusantaradigital.co.id', 'Sari Wulandari', 'sari');
    await openApp(page, '?lang=id&theme=dark');
    await expect(banner(page)).toContainText('Anda diundang ke Test Organisation');
    await expect(banner(page).locator('button', { hasText: /^Terima$/ })).toBeVisible();
    const problems = await page.evaluate(() => {
      const el = document.querySelector('section.mx-invite');
      return el ? [...el.querySelectorAll('*')].filter((n) => n.childNodes.length && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 11.95).length : -1;
    });
    expect(problems).toBe(0);
  });
});
