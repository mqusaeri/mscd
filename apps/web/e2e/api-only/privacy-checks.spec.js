import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Personal data checks against the api (MILESTONE-3 M3-04, D.6.4), as rina, Management System Manager of the ISMS of
// PT Nusantara Digital Teknologi and one of its Tenant Admins: an erasure request of a person without an account opens a
// check of the ISMS, whose context issue names the person; the check shows that record with a link to Registers, and
// "Mark checked" needs a note. A member's request links to Handover for the member's open items. Every form and
// drawer is readable in both themes. The people are invented (R-19), in the database the test stack made (R-20).
const dialog = (page) => ui.modal(page);
const drawer = (page) => ui.drawer(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');
const LABEL = 'Personal data checks';

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
  return res.status() === 204 ? null : res.json();
}

async function record(page, baseURL, body) {
  const res = await apiWrite(page, baseURL, 'POST', '/api/v1/admin/privacy-requests', { receivedAt: new Date(Date.now() - 3_600_000).toISOString(), channel: 'letter', ...body });
  return res.data;
}

test.describe('Personal data checks against the api @api-only', () => {
  test('shows the record that names the person, opens it in Registers and marks the check done', async ({ page, baseURL }) => {
    await apiWrite(page, baseURL, 'POST', '/api/v1/ms/isms/registers/context-issues', {
      code: 'CI-PRIV-01', title: 'Camera footage request from supplier contact Bima Haryanto', ownerHandle: 'rina', issueType: 'external', linkedMs: ['isms'],
    });
    const { requestNo } = await record(page, baseURL, { type: 'erasure', subject: { name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' } });
    await openApp(page);
    await go(page, LABEL);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(requestNo);
    await expect(rows(page).first()).toContainText('To check');
    await expectReadableText(page, 4.5);
    await rows(page).first().click();
    await expect(drawer(page)).toContainText('Bima Haryanto (No account in this organisation)');
    const found = drawer(page).locator('table tbody tr', { hasText: 'CI-PRIV-01' });
    await expect(found).toContainText('Context issue');
    await expect(found).toContainText('Title');
    await expect(found).toContainText('Bima Haryanto');
    await expect(drawer(page)).not.toContainText('Open Handover');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Mark checked').click();
    await button(dialog(page), 'Mark checked').click();
    await expect(dialog(page)).toContainText('Fill in this field.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea').fill('Context issue CI-PRIV-01 edited to name the supplier only');
    await button(dialog(page), 'Mark checked').click();
    await expectToast(page, `The check of ${requestNo} is done`);
    await expect(drawer(page).locator('.mx-reason')).toHaveText('This check is already done.');
    await found.locator('button', { hasText: /^Open$/ }).click();
    await expect(ui.title(page)).toHaveText('Registers');
  });

  test('a member\'s check links to Handover; the Indonesian drawer is readable', async ({ page, baseURL }) => {
    const users = (await (await page.request.get(`${baseURL}/api/v1/admin/users?pageSize=200`)).json()).items;
    const bagus = users.find((u) => u.handle === 'bagus');
    const { requestNo } = await record(page, baseURL, { type: 'access', subject: { userId: bagus.id } });
    await openApp(page);
    await go(page, LABEL);
    await rows(page).filter({ hasText: requestNo }).click();
    await expect(drawer(page)).toContainText('Bagus Prasetyo');
    await expect(drawer(page)).toContainText('Move the open items of Bagus Prasetyo in this system to someone else.');
    await button(drawer(page), 'Open Handover').click();
    await expect(ui.title(page)).toHaveText('Handover');

    await openApp(page, '?lang=id');
    await go(page, 'Pemeriksaan data pribadi');
    await rows(page).filter({ hasText: requestNo }).click();
    await expect(drawer(page)).toContainText('Rekaman yang menyebut orang tersebut');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});
