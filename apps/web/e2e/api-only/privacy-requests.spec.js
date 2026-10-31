import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Personal data requests against the api (MILESTONE-3 M3-04, D.6), as rina, Tenant Admin of PT Nusantara Digital
// Teknologi: a request of a person without an account recorded on screen, started and closed; a member's request to
// stop using their data, which disables the membership; an access request with one check per system and a queued copy
// of the data (the test stack runs no worker, so the copy stays queued); and an erasure of a member who still holds open
// items, refused in the confirmation once every system is checked; a note, a withdrawal and a refusal; and a correction
// of an account that belongs to the test organisation alone. Every form and drawer is readable in both themes.
// The people are the invented people of the demo seed (R-19), in the database the test stack made (R-20).
const dialog = (page) => ui.modal(page);
const drawer = (page) => ui.drawer(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');
const LABEL = 'Personal data requests';

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function signIn(page, baseURL, handle, org = 'ndt') {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data, headers = {}) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID(), ...headers } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

async function apiRead(page, baseURL, url) {
  const res = await page.request.get(`${baseURL}${url}`);
  expect(res.ok(), `GET ${url}: ${await res.text()}`).toBe(true);
  return res.json();
}

async function members(page, baseURL) {
  return (await apiRead(page, baseURL, '/api/v1/admin/users?pageSize=200')).items;
}

/** Records a request through the api as rina; its id and number. */
async function record(page, baseURL, body) {
  const res = await apiWrite(page, baseURL, 'POST', '/api/v1/admin/privacy-requests', { receivedAt: new Date(Date.now() - 3_600_000).toISOString(), channel: 'email', ...body });
  return res.data;
}

/** Marks every system check of a request done, each as the system's Management System Manager, then signs rina in. */
async function checkEverySystem(page, baseURL, id) {
  const people = await members(page, baseURL);
  const detail = await apiRead(page, baseURL, `/api/v1/admin/privacy-requests/${id}`);
  for (const check of detail.checks) {
    const manager = people.find((u) => u.roles.some((r) => r.ms === check.ms && r.role === 'ms_manager' && r.approvalStatus === 'active'));
    expect(manager, `a manager of ${check.ms}`).toBeTruthy();
    await signIn(page, baseURL, manager.handle);
    await apiWrite(page, baseURL, 'POST', `/api/v1/ms/${check.ms}/privacy-checks/${check.id}/done`, { note: `Checked ${check.ms}` });
  }
  await signIn(page, baseURL, 'rina');
}

async function openRequest(page, requestNo) {
  await openApp(page);
  await go(page, LABEL);
  await rows(page).filter({ hasText: requestNo }).click();
  await expect(drawer(page)).toContainText(`Request ${requestNo}`);
}

test.describe('Personal data requests against the api @api-only', () => {
  test('records the request of a person without an account, starts it and closes it with the answer', async ({ page }) => {
    await openApp(page);
    await go(page, LABEL);
    await expect(page.locator('main')).toContainText('No requests yet');
    await expectReadableText(page, 4.5);
    await ui.pageAction(page, 'Record request').click();
    await expect(dialog(page)).toContainText('Record a personal data request');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select').first().selectOption('restriction');
    await dialog(page).locator('label', { hasText: 'Someone without an account' }).click();
    await button(dialog(page), 'Record').click();
    await expect(dialog(page)).toContainText('Fill in this field.');
    const inputs = dialog(page).locator('input[type="text"], input[type="email"]');
    await inputs.nth(0).fill('Wulan Kartika');
    await inputs.nth(1).fill('wulan.kartika@supplier.example');
    await dialog(page).locator('select').nth(1).selectOption('letter');
    await dialog(page).locator('textarea').fill('Asks the organisation to stop sending her the supplier newsletter');
    await button(dialog(page), 'Record').click();
    await expectToast(page, /Request PR-\d{4}-\d{3} recorded/);
    await expect(drawer(page)).toContainText('Wulan Kartika (No account in this organisation)');
    await expect(drawer(page)).toContainText('wulan.kartika@supplier.example');
    await expect(drawer(page)).toContainText('Letter');
    await inBothThemes(page, () => expectOverlayReadable(page));

    await button(drawer(page), 'Start work').click();
    await dialog(page).locator('textarea').fill('Letter signed on the supplier letterhead');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Start work').click();
    await expectToast(page, /Work on PR-\d{4}-\d{3} started/);
    await expect(drawer(page)).toContainText('In progress');
    await expect(drawer(page)).toContainText('Letter signed on the supplier letterhead');
    await button(drawer(page), 'Close with the answer').click();
    await expect(dialog(page)).toContainText(/Close PR-\d{4}-\d{3}/);
    await dialog(page).locator('textarea').fill('Removed from the newsletter list; answered by letter');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close with the answer').click();
    await expectToast(page, /Request PR-\d{4}-\d{3} completed/);
    await expect(drawer(page)).toContainText('Completed');
    await expect(drawer(page)).toContainText('Removed from the newsletter list; answered by letter');
    await page.locator('div[style*="z-index: 40"]').click({ position: { x: 20, y: 450 } });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Answered');
  });

  test('a member\'s request to stop using their data disables the membership', async ({ page, baseURL }) => {
    const maya = (await members(page, baseURL)).find((u) => u.handle === 'maya');
    const { requestNo } = await record(page, baseURL, { type: 'restriction', subject: { userId: maya.id } });
    await openRequest(page, requestNo);
    await expect(drawer(page)).toContainText('Maya Putri');
    await expect(drawer(page).locator('[data-actions] .mx-reason').first()).toHaveText('Start work first.');
    await button(drawer(page), 'Start work').click();
    await dialog(page).locator('textarea').fill('Asked in person with her staff card');
    await button(dialog(page), 'Start work').click();
    await expectToast(page, `Work on ${requestNo} started`);
    await button(drawer(page), 'Stop using the data').click();
    await expect(dialog(page)).toContainText('The membership is disabled');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Stop using the data').click();
    await expectToast(page, `The membership of ${requestNo} is disabled`);
    await expect(drawer(page)).toContainText('Membership disabled');
    expect((await members(page, baseURL)).find((u) => u.handle === 'maya').membershipStatus).toBe('disabled');
    await button(drawer(page), 'Close with the answer').click();
    await dialog(page).locator('textarea').fill('Membership disabled as asked');
    await button(dialog(page), 'Close with the answer').click();
    await expectToast(page, `Request ${requestNo} completed`);
  });

  test('an access request has a check per system and queues a copy; erasing a member with open items is refused', async ({ page, baseURL }) => {
    const bagus = (await members(page, baseURL)).find((u) => u.handle === 'bagus');
    const access = await record(page, baseURL, { type: 'access', subject: { userId: bagus.id } });
    await openRequest(page, access.requestNo);
    const systems = drawer(page).locator('table tbody tr');
    expect(await systems.count()).toBeGreaterThan(1);
    await expect(systems.first()).toContainText('Open');
    await button(drawer(page), 'Start work').click();
    await dialog(page).locator('textarea').fill('Video call with his manager present');
    await button(dialog(page), 'Start work').click();
    await expectToast(page, `Work on ${access.requestNo} started`);
    await expect(drawer(page).locator('[data-actions]')).toContainText('Wait until every system check is done.');
    await button(drawer(page), 'Prepare a copy of the data').click();
    await expectToast(page, 'The copy is being prepared.');
    await expect(drawer(page)).toContainText('Copies prepared');
    await button(drawer(page), 'Download the copy').click();
    await expectToast(page, 'The copy is being prepared.');
    await inBothThemes(page, () => expectOverlayReadable(page));

    const erasure = await record(page, baseURL, { type: 'erasure', subject: { userId: bagus.id } });
    const detail = await apiRead(page, baseURL, `/api/v1/admin/privacy-requests/${erasure.id}`);
    await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/privacy-requests/${erasure.id}`, { action: 'start', identityCheckNote: 'Signed letter' }, { 'if-match': detail.etag });
    await checkEverySystem(page, baseURL, erasure.id);
    await openRequest(page, erasure.requestNo);
    await button(drawer(page), 'Erase the person').click();
    await expect(dialog(page)).toContainText('This cannot be undone.');
    await expect(dialog(page)).toContainText('What stays');
    const confirm = button(dialog(page), 'Erase the person');
    await expect(confirm).toBeDisabled();
    await dialog(page).locator('input').fill('ERASE');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await confirm.click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Bagus Prasetyo still holds');
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Hand them over to someone else first');
    await inBothThemes(page, () => expectOverlayReadable(page));
    expect((await members(page, baseURL)).find((u) => u.handle === 'bagus').membershipStatus).toBe('active');
  });

  test('adds a note, records a withdrawal and refuses a request, each form readable in both themes', async ({ page, baseURL }) => {
    const withdrawn = await record(page, baseURL, { type: 'access', subject: { name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' } });
    const refused = await record(page, baseURL, { type: 'restriction', subject: { name: 'Wulan Kartika', email: 'wulan.kartika@supplier.example' } });
    await openRequest(page, withdrawn.requestNo);
    await button(drawer(page), 'Add note').click();
    await expect(dialog(page)).toContainText(`Note on ${withdrawn.requestNo}`);
    await dialog(page).locator('textarea').fill('Called back to ask which supplier contract the request is about');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Add note').click();
    await expectToast(page, 'Note added');
    await expect(drawer(page)).toContainText('Called back to ask which supplier contract the request is about');
    await button(drawer(page), 'Record withdrawal').click();
    await expect(dialog(page)).toContainText(`Record that the person withdrew ${withdrawn.requestNo}`);
    await button(dialog(page), 'Record withdrawal').click();
    await expect(dialog(page)).toContainText('Fill in this field.');
    await dialog(page).locator('textarea').fill('Withdrawn by email after the contract question was answered');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record withdrawal').click();
    await expectToast(page, `Withdrawal of ${withdrawn.requestNo} recorded`);
    await expect(drawer(page)).toContainText('Withdrawn');
    await expect(button(drawer(page), 'Refuse')).toHaveCount(0);

    await openRequest(page, refused.requestNo);
    await button(drawer(page), 'Refuse').click();
    await expect(dialog(page)).toContainText(`Refuse ${refused.requestNo}`);
    await dialog(page).locator('textarea').fill('The organisation holds no data about this person beyond the request');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Refuse').click();
    await expectToast(page, `Request ${refused.requestNo} refused`);
    await expect(drawer(page)).toContainText('Refused');
    await expect(drawer(page)).toContainText('The organisation holds no data about this person beyond the request');
  });

  test('corrects the name and job title of an account that belongs to this organisation only', async ({ page, baseURL }) => {
    // mfa.tester belongs to the test organisation alone, so a Tenant Admin there corrects the account itself.
    await signIn(page, baseURL, 'rina', 'tst');
    const tester = (await members(page, baseURL)).find((u) => u.handle === 'mfa.tester');
    expect(tester, 'mfa.tester in the test organisation').toBeTruthy();
    const { requestNo } = await record(page, baseURL, { type: 'rectification', subject: { userId: tester.id }, note: 'The job title changed last month' });
    await openRequest(page, requestNo);
    await expect(drawer(page).locator('[data-actions] .mx-reason').first()).toHaveText('Start work first.');
    await button(drawer(page), 'Start work').click();
    await dialog(page).locator('textarea').fill('Asked from the work email address the organisation knows');
    await button(dialog(page), 'Start work').click();
    await expectToast(page, `Work on ${requestNo} started`);
    await button(drawer(page), 'Correct name or job title').click();
    await expect(dialog(page)).toContainText(`Correct the account of ${requestNo}`);
    await expect(dialog(page)).toContainText('Only an account that belongs to this organisation alone can be corrected here.');
    const fields = dialog(page).locator('input[type="text"]');
    await expect(fields.nth(0)).toHaveValue('MFA Tester');
    await fields.nth(1).fill('Senior Analyst');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Correct name or job title').click();
    await expectToast(page, `The account of ${requestNo} is corrected`);
    expect((await members(page, baseURL)).find((u) => u.handle === 'mfa.tester')).toMatchObject({ displayName: 'MFA Tester', jobTitle: 'Senior Analyst' });
    await button(drawer(page), 'Close with the answer').click();
    await dialog(page).locator('textarea').fill('Job title corrected as asked');
    await button(dialog(page), 'Close with the answer').click();
    await expectToast(page, `Request ${requestNo} completed`);
  });

  test('the Indonesian screen is readable in both themes', async ({ page, baseURL }) => {
    await record(page, baseURL, { type: 'erasure', subject: { name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' } });
    await openApp(page, '?lang=id');
    await go(page, 'Permintaan data pribadi');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Penghapusan');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    await rows(page).first().click();
    await expect(drawer(page)).toContainText('Pemeriksaan sistem');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});
