import { createHash } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Organisation export against the api (MILESTONE-3 M3-09, D.4). In the Test Organisation tenant.admin and rina are the
// two Tenant Admins. tenant.admin asks for an export, which waits for the other Tenant Admin (the requester sees "You
// requested this export" and cannot decide it); rina refuses a second request while one waits, approves it, and the
// export is queued for the worker; a request rejected by rina shows her reason. The API stack runs no worker, so the
// ready export with its parts and the banner of the read-only period come from `page.route` answers in the shapes of
// @mscd/shared, as ops-organizations.spec.js does for the SaaS answers: the screen shows the SHA-256 of each part and of
// the manifest and starts each download from the api's link. Chromium sends a download started by a link past
// `page.route`, so the bytes and their `X-MSCD-SHA256` header are covered by test/int/org-export. Every dialog and the
// drawer are readable in both themes.
const rows = (page) => page.locator('main [data-org-export] table tbody tr');
const rowOf = (page, status) => rows(page).filter({ has: page.locator(`[data-export-status="${status}"]`) });

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function exportsOf(page, baseURL) {
  const res = await page.request.get(`${baseURL}/api/v1/admin/organization/exports`);
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Organisation export against the api @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('tenant.admin asks, the request waits for rina, who refuses a second one and approves it', async ({ page, baseURL }) => {
    await openApp(page);
    await go(page, 'Organisation export');
    await expect(page.locator('main [data-org-export]')).toContainText('No export yet');
    await expectReadableText(page, 4.5);
    await ui.pageAction(page, 'Export all data').click();
    const dialog = ui.modal(page);
    await expect(dialog).toContainText('What the export holds');
    await expect(dialog.locator('[data-approval="other"]')).toContainText('Another Tenant Admin must approve the request before MSCD builds the export.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog.locator('textarea').fill('Copy for the annual records archive');
    await dialog.getByRole('button', { name: 'Export all data' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'The export waits for another Tenant Admin to approve it.');
    const own = rowOf(page, 'requested');
    await expect(own).toContainText('by Tenant Admin');
    await expect(own).toContainText('You requested this export');
    await expect(own.getByRole('button', { name: 'Approve' })).toBeDisabled();
    const [requested] = await exportsOf(page, baseURL);
    expect(requested).toMatchObject({ status: 'requested', requestedVia: 'tenant_admin', requestedBy: { handle: 'tenant.admin' }, decidedBy: null });
    await own.getByRole('button', { name: 'Open' }).click();
    await expect(ui.drawer(page).locator('[data-no-files="requested"]')).toBeVisible();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');

    // rina, the other Tenant Admin of tst.
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Organisation export');
    const waiting = rowOf(page, 'requested');
    await expect(waiting).toContainText('Another Tenant Admin decides');
    await ui.pageAction(page, 'Export all data').click();
    await dialog.getByRole('button', { name: 'Export all data' }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('Another export of this organisation is waiting for approval or being built.');
    await page.keyboard.press('Escape');
    await waiting.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog).toContainText('Approve this export?');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'Export approved. MSCD builds it now.');
    await expect(rowOf(page, 'queued')).toContainText('Approved by Rina Kusuma');
    await expect(page.locator('main')).toContainText('MSCD is building an export.');
    const [queued] = await exportsOf(page, baseURL);
    expect(queued).toMatchObject({ id: requested.id, status: 'queued', decidedBy: { handle: 'rina' } });
  });

  test('a rejection needs a reason, which the requester then sees', async ({ page, baseURL }) => {
    await openApp(page);
    await go(page, 'Organisation export');
    await ui.pageAction(page, 'Export all data').click();
    const dialog = ui.modal(page);
    await dialog.getByRole('button', { name: 'Export all data' }).click();
    await expect(dialog).toHaveCount(0);
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Organisation export');
    await rowOf(page, 'requested').getByRole('button', { name: 'Reject' }).click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toContainText('Write the reason for the rejection.');
    await dialog.locator('textarea').fill('Not before the management review in December');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'Export rejected');
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Organisation export');
    await expect(rowOf(page, 'rejected')).toContainText('Rejected by Rina Kusuma');
    await rowOf(page, 'rejected').getByRole('button', { name: 'Open' }).click();
    await expect(ui.drawer(page)).toContainText('Not before the management review in December');
    await expect(ui.drawer(page).locator('[data-no-files="rejected"]')).toBeVisible();
    const [rejected] = await exportsOf(page, baseURL);
    expect(rejected).toMatchObject({ status: 'rejected', decisionNote: 'Not before the management review in December' });
  });

  test('a ready export: the SHA-256 of each part and of the manifest, each download started from the api link of its file; the banner of the read-only period', async ({ page }) => {
    const shared = await import('@mscd/shared');
    const parts = [1, 2].map((n) => Buffer.from(`MSCD export part ${n} of 2 for the browser test\n`.repeat(n * 40)));
    const manifest = Buffer.from(`${JSON.stringify({ format: 'mscd-organization-export', version: 1, parts: parts.map((p, i) => ({ part: i + 1, sizeBytes: p.length })) })}\n`);
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    const id = '5a6b7c8d-9e0f-4a1b-8c2d-0000000e2e01';
    const base = {
      id, status: 'ready', requestedVia: 'offboarding', requestedBy: null, requestedAt: '2026-10-31T02:00:00Z', decidedBy: null, decidedAt: null, decisionNote: null,
      isFinal: true, partCount: 2, fileCount: 412, sizeBytes: parts[0].length + parts[1].length, expiresAt: null, completedAt: '2026-10-31T03:10:00Z', downloadCount: 0, error: null,
    };
    const item = shared.OrganizationExportItem.parse(base);
    const detail = shared.OrganizationExportDetail.parse({
      ...base, parts: parts.map((p, i) => ({ part: i + 1, name: `mscd-export-tst-2026-10-31-part-${i + 1}.tar.gz`, sizeBytes: p.length, sha256: sha(p) })), manifestSha256: sha(manifest),
    });
    await page.route(/\/api\/v1\/admin\/organization(\/exports(\/[^/]*)?)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/v1/admin/organization') {
        const response = await route.fetch();
        const settings = await response.json();
        return route.fulfill({ response, json: shared.OrganizationSettings.parse({ ...settings, offboardingEndsAt: '2026-11-30T03:00:00Z', deletionScheduledFor: '2026-12-30T03:00:00Z' }) });
      }
      if (url.pathname === '/api/v1/admin/organization/exports') return route.fulfill({ json: [item] });
      if (url.pathname === `/api/v1/admin/organization/exports/${id}`) return route.fulfill({ json: detail });
      return route.fallback();
    });
    await openApp(page);
    // The banner of the host layer on another screen, clear of the sidebar.
    await go(page, 'Licence');
    const banner = page.locator('[data-read-only-banner]');
    await expect(banner).toContainText('Read-only until 30 Nov 2026');
    await expect(banner).toContainText('MSCD deletes all data of the organisation for good on 30 Dec 2026.');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    const sidebar = await page.locator('aside').boundingBox();
    expect((await banner.boundingBox()).x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    await banner.getByRole('button', { name: 'Open Organisation export' }).click();
    await expect(ui.title(page)).toHaveText('Organisation export');
    await expect(page.locator('[data-read-only-banner]')).toHaveCount(0);
    await expect(page.locator('main [data-read-only-note]')).toContainText('Download the final export before then');
    await expect(rowOf(page, 'ready')).toContainText('Not needed: end of contract');
    await expect(rowOf(page, 'ready')).toContainText('Until the organisation closes');
    await rowOf(page, 'ready').getByRole('button', { name: 'Open' }).click();
    const drawer = ui.drawer(page);
    await expect(drawer.locator('[data-sha256]')).toHaveCount(3);
    await inBothThemes(page, () => expectOverlayReadable(page));
    const buttons = drawer.getByRole('button', { name: 'Download' });
    // A part is saved under its own name; the manifest under the server's (Content-Disposition).
    const expected = [
      ...detail.parts.map((p) => ({ path: `/api/v1/admin/organization/exports/${id}/parts/${p.part}`, name: p.name, sha: p.sha256 })),
      { path: `/api/v1/admin/organization/exports/${id}/manifest`, name: null, sha: detail.manifestSha256 },
    ];
    // Only the address of each download is checked here: Chromium sends it past `page.route` to the real api, which
    // has no such export and answers 404. The bytes and their SHA-256 are covered by test/int/org-export.
    for (let i = 0; i < 3; i++) {
      await expect(drawer.locator('[data-sha256]').nth(i)).toHaveText(expected[i].sha);
      const [download] = await Promise.all([page.waitForEvent('download'), buttons.nth(i).click()]);
      expect(new URL(download.url()).pathname).toBe(expected[i].path);
      if (expected[i].name) expect(download.suggestedFilename()).toBe(expected[i].name);
    }
    await expect(drawer.locator('[data-how-to-check]')).toContainText('Get-FileHash mscd-export-tst-2026-10-31-part-1.tar.gz -Algorithm SHA256');
  });
});
