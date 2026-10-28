import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Pending approvals against the api (MILESTONE-2 M2-10, F.6, A-50). In the Test Organisation tenant.admin and rina are
// the two Tenant Admins. tenant.admin makes bagus a Storage Admin and grants him a role, which waits; tenant.admin
// (who asked) cannot decide on it, rina (who neither asked nor receives it) approves it. A grant to rina or
// tenant.admin would have no approver in tst, because the grantee never decides either. A routing change rina asks for
// waits too, and tenant.admin rejects it on the same screen. In the dark theme rina rejects a grant after the
// confirmation.
const dialog = (page) => ui.modal(page);
const grantRows = (page) => page.locator('main [data-approvals="grants"] tbody tr');
const ruleRows = (page) => page.locator('main [data-approvals="rules"] tbody tr');

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, {
    method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
  });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

async function memberId(page, baseURL, handle) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/users?pageSize=200`)).json();
  return list.items.find((u) => u.handle === handle).id;
}

async function systemId(page, baseURL, slug) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/management-systems`)).json();
  return list.find((s) => s.slug === slug).id;
}

test.describe('Pending approvals against the api @api-only', () => {
  test.use({ apiSession: null });

  test('a grant to an administrator waits; the requester cannot decide and rina approves it', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/users/${await memberId(page, baseURL, 'bagus')}`, { adminRoles: ['storage_admin'] });
    const granted = await apiWrite(page, baseURL, 'POST', `/api/v1/admin/management-systems/${await systemId(page, baseURL, 'isms')}/roles`, { user: 'bagus', role: 'risk_owner' });
    expect(granted.data.approvalStatus).toBe('pending_approval');

    await openApp(page);
    await expect(ui.nav(page, 'Pending approvals')).toContainText('1');
    await go(page, 'Pending approvals');
    const waiting = grantRows(page).filter({ hasText: 'Bagus Prasetyo' });
    await expect(waiting).toContainText('Risk Owner, ISMS');
    await expect(waiting).toContainText('Tenant Admin');
    await expect(waiting).toContainText('Rina Kusuma');
    await expect(waiting).toContainText('You asked for this grant; another Tenant Admin decides on it.');
    await expect(waiting.locator('button', { hasText: 'Approve' })).toBeDisabled();

    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Pending approvals');
    const decide = grantRows(page).filter({ hasText: 'Bagus Prasetyo' });
    await expect(decide.locator('button', { hasText: 'Approve' })).toBeEnabled();
    await decide.locator('button', { hasText: 'Approve' }).click();
    await expectToast(page, 'Risk Owner in ISMS for Bagus Prasetyo approved');
    await expect(page.locator('main')).toContainText('Nothing is waiting for approval');
    await go(page, 'People and roles');
    const bagus = page.locator('main table tbody tr', { hasText: 'Bagus Prasetyo' });
    await expect(bagus).toContainText('Risk Owner in ISMS');
    await expect(bagus).not.toContainText('waiting for approval');
  });

  test('in the dark theme rina rejects a grant to an administrator after the confirmation', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/users/${await memberId(page, baseURL, 'bagus')}`, { adminRoles: ['storage_admin'] });
    await apiWrite(page, baseURL, 'POST', `/api/v1/admin/management-systems/${await systemId(page, baseURL, 'isms')}/roles`, { user: 'bagus', role: 'risk_owner' });

    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await darkTheme(page);
    await go(page, 'Pending approvals');
    const waiting = grantRows(page).filter({ hasText: 'Bagus Prasetyo' });
    await expect(waiting).toContainText('Administrator');
    await expectReadableText(page, 4.5);
    await waiting.locator('button', { hasText: 'Reject' }).click();
    await expect(dialog(page)).toContainText('Reject this role grant');
    await expect(dialog(page)).toContainText('Bagus Prasetyo does not get Risk Owner in ISMS.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Risk Owner in ISMS for Bagus Prasetyo rejected');
    await expect(page.locator('main')).toContainText('Nothing is waiting for approval');
    await expect(ui.nav(page, 'Pending approvals')).not.toContainText('1');
  });

  test('tenant.admin rejects a routing change rina asked for, after the confirmation', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'tst');
    const rule = await apiWrite(page, baseURL, 'POST', '/api/v1/admin/storage/routing-rules', { ms: 'isms', objectKind: 'document', repository: 'vault', mode: 'stored', priority: 70, note: 'ISMS documents to the vault' });
    expect(rule.data.approvalStatus).toBe('pending_approval');
    await openApp(page);
    await go(page, 'Pending approvals');
    await expect(ruleRows(page).filter({ hasText: 'ISMS documents to the vault' })).toContainText('You asked for this change; another Tenant Admin decides on it.');

    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Pending approvals');
    const waiting = ruleRows(page).filter({ hasText: 'ISMS documents to the vault' });
    await expect(waiting).toContainText('Rina Kusuma');
    await waiting.locator('button', { hasText: 'Reject' }).click();
    await expect(dialog(page)).toContainText('Reject this routing change');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Routing change rejected');
    await expect(ruleRows(page).filter({ hasText: 'ISMS documents to the vault' })).toHaveCount(0);
  });
});
