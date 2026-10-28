import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';
import { waitForMail } from '../../e2e-api/fixtures.js';

// People and roles against the api (MILESTONE-2 M2-10, D.2, F.6, D2-12). In the Test Organisation tenant.admin and
// rina are the two Tenant Admins. tenant.admin invites a person (the email arrives in Mailpit), makes bagus a Storage
// Admin through Edit (`admin.users.update`), then grants bagus a business role: it stays pending because bagus is now
// an administrator, and the approver list names rina, who neither asked for it nor receives it. Revoking a role and
// disabling a holder show the open items they hold (`admin.users.holdings`, counts only). Every form and confirmation is
// readable in the light and dark themes, a member is pre-registered for company sign-in and a disabled member is
// enabled again. A change of your own roles gives the session a new id and CSRF token (F.1): the screen reads GET /me
// and loads the snapshot again, so the next change in the same page is accepted and the sidebar follows. The page may
// list as waiting a grant to yourself that another Tenant Admin has approved since: the Revoke dialog reads its current
// state, and every revocation of your own grant reads GET /me.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text }).first();
const field = (page, name) => dialog(page).locator(`[name="${name}"]`);

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
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

async function memberId(page, baseURL, handle) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/users?pageSize=200`)).json();
  return list.items.find((u) => u.handle === handle).id;
}

/**
 * An enabled SAML provider of the organisation (SAML needs no discovery), for the pre-registration. The certificate
 * helper is the build output of tools/mock-providers, which only the API stack builds, so it is loaded here at run
 * time: a static import would stop the sample project (which collects this file and skips it) on a fresh checkout.
 */
async function samlProvider() {
  const { createSelfSignedCertificate } = await import('../../../../tools/mock-providers/dist/certs.js');
  // The test profile fixes the clock of the api (demo.fixed_today), so the certificate is valid from well before it.
  const certificate = createSelfSignedCertificate({ commonName: 'mscd-e2e-m2-10-users', notBefore: new Date('2026-01-01T00:00:00Z'), days: 3650 });
  return {
    slug: 'ad-fs', kind: 'saml', displayName: 'Sign in with AD FS', icon: 'generic',
    saml: {
      entryPoint: 'https://adfs.e2e.example/adfs/ls/', idpIssuer: 'http://adfs.e2e.example/adfs/services/trust', idpCerts: [certificate.certificatePem],
      spEntityId: 'http://localhost:4174/api/v1/auth/saml/ad-fs/metadata', mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'],
    },
    requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [],
  };
}

/** Opens a dialog from the drawer, checks it is readable, and cancels it. */
async function readableThenCancel(page, label, title) {
  await drawer(page).locator('button', { hasText: label }).first().click();
  await expect(dialog(page)).toContainText(title);
  await expectOverlayReadable(page);
  await dialog(page).locator('button', { hasText: /^Cancel$/ }).click();
  await expect(dialog(page)).toHaveCount(0);
}

async function openPerson(page, name) {
  await row(page, name).click();
  await expect(drawer(page)).toContainText(name);
}

test.describe('People and roles against the api @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('tenant.admin invites a person, who gets the invitation email', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await expect(row(page, 'Rina Kusuma')).toContainText('Tenant Admin');
    await expect(row(page, 'Rina Kusuma')).toContainText('MS Manager in ISMS, primary');
    await expect(row(page, 'tenant.admin@mscd.test')).toContainText('You');
    await ui.pageAction(page, 'Invite person').click();
    await field(page, 'email').fill('wulan.sari@mscd.test');
    await field(page, 'displayName').fill('Wulan Sari');
    await field(page, 'jobTitle').fill('Quality Analyst');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Send invitation' }).click();
    await expectToast(page, 'Invitation sent to wulan.sari@mscd.test');
    const [link] = await waitForMail('wulan.sari@mscd.test', /https?:\/\/\S+\/invite#token=[A-Za-z0-9_-]+/);
    expect(link).toContain('/invite#token=');
    await expect(row(page, 'wulan.sari@mscd.test')).toContainText('Invited');
  });

  test('Edit makes bagus a Storage Admin; a grant to bagus then waits, and the approver list names rina', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await openPerson(page, 'Bagus Prasetyo');
    await expect(drawer(page)).toContainText('Domain Owner in ISMS');
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await expect(dialog(page)).toContainText('Edit Bagus Prasetyo');
    // bagus is a member of other organisations too: the job title is his own (F.6).
    await expect(field(page, 'jobTitle')).toBeDisabled();
    await dialog(page).getByLabel('Storage Admin').check();
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'Changes saved');
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Storage Admin');

    await drawer(page).locator('button', { hasText: 'Grant role' }).click();
    await expect(dialog(page)).toContainText('Bagus Prasetyo is an administrator, so another Tenant Admin must approve this grant before it applies.');
    await expect(dialog(page)).toContainText('Who can approve: Rina Kusuma');
    await field(page, 'ms').selectOption({ index: 1 });
    await field(page, 'role').selectOption({ label: 'Risk Owner' });
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Grant role' }).click();
    await expectToast(page, 'Role grant waiting for approval');
    await expect(drawer(page).locator('[data-grants]')).toContainText('Risk Owner in ISMS');
    await expect(drawer(page).locator('[data-grants]')).toContainText('waiting for approval');
    await expect(page.locator('main')).toContainText('1 role grant is waiting for the approval of a second Tenant Admin.');
    await expect(ui.nav(page, 'Pending approvals')).toContainText('1');
  });

  test('revoking a role shows the open items of that system with its primary manager', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('Revoke Domain Owner in ISMS');
    const held = dialog(page).locator('[data-holdings="isms"]');
    await expect(held).toContainText(/\d+ open items/);
    await expect(held).toContainText('Primary MS Manager: Rina Kusuma (rina.kusuma@nusantaradigital.co.id)');
    await expect(held).toContainText('Ask Rina Kusuma to move these items to a successor in Handover.');
    // A Tenant Admin sees counts only (H.13) and cannot open Handover in the system.
    await expect(held.locator('button', { hasText: 'Open Handover' })).toHaveCount(0);
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    await expectToast(page, 'Role revoked');
    await expect(drawer(page)).not.toContainText('Domain Owner in ISMS');
  });

  test('disabling a holder shows the open items per system and needs the email typed; the last Tenant Admin is kept', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await row(page, 'tenant.admin@mscd.test').click();
    await expect(drawer(page)).toContainText('You cannot disable your own membership.');
    await page.keyboard.press('Escape');
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('button', { hasText: /^Disable$/ }).click();
    await expect(dialog(page)).toContainText('Disable Bagus Prasetyo');
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await expect(dialog(page)).toContainText('Ask the primary MS Manager of each system to move these items in Handover');
    await expectOverlayReadable(page);
    const confirm = dialog(page).locator('button', { hasText: /^Disable$/ });
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel('Type bagus.prasetyo@nusantaradigital.co.id to confirm').fill('bagus.prasetyo@nusantaradigital.co.id');
    await confirm.click();
    await expectToast(page, 'Bagus Prasetyo is disabled');
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Disabled');
  });

  test('every form and confirmation is readable in the light and dark themes; a member is pre-registered and a disabled member enabled again', async ({ page, baseURL }) => {
    test.slow();
    await apiWrite(page, baseURL, 'POST', '/api/v1/admin/identity-providers', await samlProvider());
    await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/users/${await memberId(page, baseURL, 'hendra')}`, { membershipStatus: 'disabled' });
    await openApp(page);
    await go(page, 'People and roles');
    await expect(row(page, 'Hendra Wijaya')).toContainText('Disabled');

    // In the light theme: the drawer, the Pre-register form and the Enable again confirmation (the other forms are
    // checked in the light theme by the tests above).
    await openPerson(page, 'Bagus Prasetyo');
    await expectOverlayReadable(page);
    await readableThenCancel(page, 'Pre-register company sign-in', 'Pre-register company sign-in for Bagus Prasetyo');
    await page.keyboard.press('Escape');
    await openPerson(page, 'Hendra Wijaya');
    await readableThenCancel(page, 'Enable again', 'Enable Hendra Wijaya again');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);

    await darkTheme(page);
    await go(page, 'People and roles');
    await expect(row(page, 'Hendra Wijaya')).toContainText('Disabled');
    await expectReadableText(page, 4.5);

    await ui.pageAction(page, 'Invite person').click();
    await expect(dialog(page)).toContainText('Invite a person');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Cancel$/ }).click();

    await openPerson(page, 'Bagus Prasetyo');
    await expectOverlayReadable(page);
    await readableThenCancel(page, /^Edit$/, 'Edit Bagus Prasetyo');
    await readableThenCancel(page, 'Grant role', 'Grant a role to Bagus Prasetyo');
    await readableThenCancel(page, 'Reset sign-in factor', 'Reset the sign-in factor of Bagus Prasetyo');
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Cancel$/ }).click();
    await drawer(page).locator('button', { hasText: /^Disable$/ }).click();
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Cancel$/ }).click();

    // Pre-register company sign-in: the one enabled provider is chosen already.
    await drawer(page).locator('button', { hasText: 'Pre-register company sign-in' }).click();
    await expect(dialog(page)).toContainText('Pre-register company sign-in for Bagus Prasetyo');
    await expect(dialog(page).locator('[name="provider"]')).toHaveValue('ad-fs');
    await dialog(page).locator('[name="subject"]').fill('bagus.prasetyo@adfs.e2e.example');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Register$/ }).click();
    await expectToast(page, 'Company sign-in registered');
    await expect(dialog(page)).toHaveCount(0);

    // Enable again: the disabled member signs in again with the roles recorded before.
    await page.keyboard.press('Escape');
    await openPerson(page, 'Hendra Wijaya');
    await drawer(page).locator('button', { hasText: 'Enable again' }).click();
    await expect(dialog(page)).toContainText('Enable Hendra Wijaya again');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Enable$/ }).click();
    await expectToast(page, 'Hendra Wijaya is active again');
    await expect(row(page, 'Hendra Wijaya')).not.toContainText('Disabled');
  });

  test('tenant.admin changes their own administration roles, then saves a second change in the same page (F.1)', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await row(page, 'tenant.admin@mscd.test').click();
    await expect(drawer(page)).toContainText('IT Administrator');
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await expect(dialog(page)).toContainText('You are editing your own administration roles.');
    await dialog(page).getByLabel('Storage Admin').check();
    // The save renews the session: the dialog reads GET /me (the new CSRF token), then the snapshot is loaded again.
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'GET');
    const snapshot = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ui/org');
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    expect((await me).ok()).toBe(true);
    expect((await snapshot).ok()).toBe(true);
    await expectToast(page, 'Changes saved');
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'tenant.admin@mscd.test')).toContainText('Storage Admin');

    // The second change in the same page, without a new page load: before the fix the server refused it (403 csrf).
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await field(page, 'jobTitle').fill('Head of IT');
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'tenant.admin@mscd.test')).toContainText('Head of IT');
    // A change of another member still goes through.
    await page.keyboard.press('Escape');
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await dialog(page).getByLabel('Storage Admin').check();
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Storage Admin');
  });

  test('tenant.admin revokes their own grant that rina approved after the page loaded: the role is revoked and the next change is accepted (F.1)', async ({ page, baseURL, playwright }) => {
    // A grant to yourself waits for a second Tenant Admin.
    const systems = await (await page.request.get(`${baseURL}/api/v1/admin/management-systems`)).json();
    const isms = systems.find((s) => s.slug === 'isms').id;
    const asked = await apiWrite(page, baseURL, 'POST', `/api/v1/admin/management-systems/${isms}/roles`, { user: 'tenant.admin', role: 'risk_owner' });
    expect(asked.data.approvalStatus).toBe('pending_approval');
    await openApp(page);
    await go(page, 'People and roles');
    await row(page, 'tenant.admin@mscd.test').click();
    const grant = drawer(page).locator('[data-grant]', { hasText: 'ISMS' });
    await expect(grant).toContainText('waiting for approval');

    // rina approves it in her own session; the page still lists it as waiting.
    const rina = await playwright.request.newContext({ baseURL });
    try {
      expect((await rina.post(`${baseURL}/api/v1/test/session`, { data: { handle: 'rina', org: 'tst' }, headers: { origin: baseURL } })).ok()).toBe(true);
      const me = await (await rina.get(`${baseURL}/api/v1/me`)).json();
      const approved = await rina.post(`${baseURL}/api/v1/admin/management-systems/${isms}/roles/${asked.data.grantId}/approve`, { headers: { origin: baseURL, 'x-csrf-token': me.csrfToken } });
      expect(approved.ok(), await approved.text()).toBe(true);
    } finally {
      await rina.dispose();
    }
    await expect(grant).toContainText('waiting for approval');

    // The dialog reads the current state of the grant: the role itself is revoked, and the session is renewed.
    await grant.locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('Tenant Admin loses this role at once.');
    await expect(dialog(page)).toContainText('This is your own role. Your session is renewed after the revocation');
    await expect(dialog(page)).not.toContainText('The request is withdrawn');
    await expectOverlayReadable(page);
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'GET');
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    expect((await me).ok()).toBe(true);
    await expectToast(page, 'Role revoked');
    await expect(drawer(page).locator('[data-grant]', { hasText: 'ISMS' })).toHaveCount(0);

    // The next change in the same page carries the renewed CSRF token: before the fix the server refused it (403 csrf).
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await field(page, 'jobTitle').fill('Head of IT');
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'tenant.admin@mscd.test')).toContainText('Head of IT');
  });

  test('the reset of a sign-in factor of a member of another organisation shows the server message', async ({ page }) => {
    await openApp(page);
    await go(page, 'People and roles');
    await openPerson(page, 'Maya Putri');
    await drawer(page).locator('button', { hasText: 'Reset sign-in factor' }).click();
    await expect(dialog(page)).toContainText('only the MSCD platform operator can reset the factor');
    await dialog(page).locator('button', { hasText: 'Reset factor' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText(/another organisation/);
    await expectOverlayReadable(page);
  });
});

test.describe('People and roles: your own role grant against the api @api-only', () => {
  // The default session is rina in PT Nusantara Digital Teknologi: a Tenant Admin and the MS Manager of each system.
  test('rina revokes her own role in ISMS: the session is renewed, the systems follow and the next change is accepted (F.1)', async ({ page }) => {
    await openApp(page);
    const systems = ui.msSwitch(page);
    await expect(systems).toContainText('ISMS');
    await go(page, 'People and roles');
    await openPerson(page, 'Rina Kusuma');
    await drawer(page).locator('[data-grant]', { hasText: 'MS Manager in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('This is your own role. Your session is renewed after the revocation');
    await expectOverlayReadable(page);
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'GET');
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    expect((await me).ok()).toBe(true);
    await expectToast(page, 'Role revoked');
    await expect(drawer(page)).not.toContainText('MS Manager in ISMS');
    // The reloaded snapshot no longer lists ISMS among her systems; People and roles stays open.
    await expect(systems).not.toContainText('ISMS');
    await expect(ui.title(page)).toHaveText('People and roles');
    await page.keyboard.press('Escape');
    await systems.click();
    const menu = page.locator('header div[style*="z-index: 30"]');
    await expect(menu).toContainText('QMS');
    await expect(menu).not.toContainText('ISMS');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The next change in the same page carries the renewed CSRF token.
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await dialog(page).getByLabel('Storage Admin').check();
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Storage Admin');
  });
});
