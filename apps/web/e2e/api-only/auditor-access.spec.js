import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// Auditor access against the api (MILESTONE-2 M2-15, F.14, E.7). rina is the MS Manager of the ISMS of PT Nusantara
// Digital Teknologi (`auditor_access.grant`), maya its Internal Auditor (`ms.read`). The ISMS has no guest grant and no
// evidence pack in the seed.
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: name });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json().catch(() => null);
}

test.describe('Auditor access against the api @api-only', () => {
  test('rina grants access from Audit readiness and from the screen, and revokes a grant', async ({ page }) => {
    await openApp(page);
    await go(page, 'Audit readiness');
    await ui.pageAction(page, 'Auditor access').click();
    await expect(dialog(page)).toContainText('Grant auditor access');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="email"]').fill('lead.auditor@certifier.co.id');
    await dialog(page).locator('input[name="days"]').fill('31');
    await button(dialog(page), 'Grant access').click();
    await expect(dialog(page)).toContainText('Enter a whole number from 1 to 30.');
    await dialog(page).locator('input[name="days"]').fill('10');
    await button(dialog(page), 'Grant access').click();
    await expectToast(page, 'Guest access created, valid 10 days. The link was emailed to lead.auditor@certifier.co.id.');
    await expect(dialog(page)).toHaveCount(0);

    await go(page, 'Auditor access');
    await expect(tab(page, 'Guest access')).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('lead.auditor@certifier.co.id');
    await expect(rows(page).first()).toContainText('Active');
    await expect(rows(page).first()).toContainText('Not used yet');
    const grants = await (await page.request.get('/api/v1/ms/isms/auditor-access')).json();
    expect(Math.abs(Date.parse(grants[0].expiresAt) - Date.parse(grants[0].createdAt) - 10 * 86_400_000)).toBeLessThan(60_000);

    await ui.pageAction(page, 'Grant access').click();
    await dialog(page).locator('input[name="email"]').fill('second.auditor@certifier.co.id');
    await button(dialog(page), 'Grant access').click();
    await expectToast(page, 'Guest access created, valid 14 days.');
    await expect(rows(page)).toHaveCount(2);
    const second = rows(page).filter({ hasText: 'second.auditor@certifier.co.id' });
    await button(second, 'Revoke').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Revoke').click();
    await expectToast(page, 'Access of second.auditor@certifier.co.id revoked');
    await expect(second).toContainText('Revoked');
    await expect(second).toContainText('by Rina Kusuma');
  });

  test('lists a queued evidence pack of the ISMS without downloads', async ({ page, baseURL }) => {
    // The stack runs no worker (e2e-api/stack.mjs), so the pack stays queued; the downloads of a ready pack are covered by
    // the unit tests and the sample build.
    await openApp(page);
    await apiWrite(page, baseURL, 'POST', '/api/v1/ms/isms/evidence-packs', {});
    await go(page, 'Auditor access');
    await tab(page, 'Evidence packs').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Queued');
    await expect(rows(page).first()).toContainText('Not built yet');
    await expect(rows(page).first().locator('button')).toHaveCount(0);
  });
});

test.describe('Auditor access for the Internal Auditor @api-only', () => {
  test.use({ apiSession: 'maya' });

  test('maya reads the evidence packs only', async ({ page }) => {
    await openApp(page);
    await go(page, 'Auditor access');
    await expect(page.locator('main [role="tab"]')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Evidence packs');
    await expect(page.locator('main')).toContainText('No evidence pack has been built for this system yet.');
    await expect(ui.pageAction(page, 'Grant access')).toHaveCount(0);
  });
});
