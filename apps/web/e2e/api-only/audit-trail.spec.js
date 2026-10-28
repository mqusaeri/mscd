import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectOverlayReadable } from '../helpers.js';

// Audit trail against the api (MILESTONE-2 M2-15, F.11, D.3). rina is the MS Manager of the ISMS (`audit_trail.read`)
// and a Tenant Admin (`audit_trail.metadata.read`); maya, the Internal Auditor, has no audit trail. The test adds an
// audit event first, so the trail holds an entry the test knows.
const rows = (page) => page.locator('main table tbody tr');
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

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

test.describe('Audit trail against the api @api-only', () => {
  test('rina filters the entries, opens one, verifies the chain and downloads the CSV and the anchors', async ({ page, baseURL }) => {
    await openApp(page);
    await apiWrite(page, baseURL, 'POST', '/api/v1/ms/isms/audit-events', {
      eventType: 'special', nameEn: 'Special audit of the data centre', nameId: 'Audit khusus pusat data', shortLabel: 'Special DC', scheduledAt: '2026-12-01',
    });
    await go(page, 'Audit trail');
    await expect(rows(page).first()).toBeVisible();
    await page.locator('main select[name="action"]').selectOption('audit_event.created');
    await expect(rows(page).first()).toContainText('audit_event.created');
    for (const text of await rows(page).allInnerTexts()) expect(text).toContain('audit_event.created');
    await page.locator('main select[name="person"]').selectOption({ label: 'Rina Kusuma' });
    await rows(page).filter({ hasText: 'Special DC' }).first().click();
    await expect(ui.drawer(page)).toContainText('Audit entry');
    await expect(ui.drawer(page)).toContainText('event_type: - > special');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);

    await button(page.locator('main'), 'Verify chain').click();
    await expect(page.locator('main [data-chain-result]')).toContainText('entries checked');
    await expect(page.locator('main [data-chain-result]')).toContainText('audit_trail: intact');
    const [csv] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Export CSV').click()]);
    expect(csv.suggestedFilename()).toMatch(/^audit-trail-isms-\d{4}-\d{2}-\d{2}\.csv$/);
    const [anchors] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Download anchors').click()]);
    expect(anchors.suggestedFilename()).toMatch(/\.ndjson$/);
  });

  test('rina, a Tenant Admin, reads who and when for the whole organisation', async ({ page }) => {
    await openApp(page);
    await go(page, 'Audit trail');
    await page.locator('main select[name="view"]').selectOption('org');
    await expect(page.locator('main thead')).toContainText('System');
    await expect(rows(page).first()).toBeVisible();
    await expect(page.locator('main button', { hasText: 'Export CSV' })).toBeDisabled();
    await rows(page).first().click();
    await expect(ui.drawer(page)).toContainText('Only who and when are shown at organisation level.');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});

test.describe('Audit trail for the Internal Auditor @api-only', () => {
  test.use({ apiSession: 'maya' });

  test('maya has no audit trail', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('aside nav button[title="Audit trail"]')).toHaveCount(0);
  });
});
