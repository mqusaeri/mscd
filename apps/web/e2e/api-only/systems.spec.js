import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, switchMs, chip, chipCount, expectToast, expectOverlayReadable } from '../helpers.js';

// Management systems against the api (MILESTONE-2 M2-09, D2-09). tenant.admin of the Test Organisation creates an
// ISO/IEC 27001 system: it starts in setup with its 93 controls and 30 clause rows, "Start implementation" is refused
// until an MS Manager is granted, and that manager's Controls screen then lists the 123 entries. The edition
// transition drawer of the Framework library is checked with rina, MS Manager of the ISO 9001 system in transition.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, code) => rows(page).filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${code}$`) }) });
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);

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
  return res.json().catch(() => null);
}

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

async function systemId(page, baseURL, slug) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/management-systems`)).json();
  return list.find((s) => s.slug === slug).id;
}

test.describe('Management systems against the api @api-only', () => {
  test.use({ apiSession: null });

  test('a new ISO/IEC 27001 system starts implementing once it has an MS Manager, whose Controls screen lists 123 entries', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Management systems');
    await expect(row(page, 'ISMS')).toContainText('ISO/IEC 27001 2022');
    await expect(row(page, 'ISMS')).toContainText('Rina Kusuma');

    await ui.pageAction(page, 'New management system').click();
    await field(page, 'code').fill('ISMS2');
    await expect(field(page, 'slug')).toHaveValue('isms2');
    await field(page, 'name').fill('Information security, Surabaya site');
    await drawer(page).locator('select').first().selectOption('ISO27001-2022');
    await expect(drawer(page)).toContainText('Installed');
    await field(page, 'scopeStatement').fill('Managed services operations at the Surabaya data centre');
    await field(page, 'certificationBody').fill('PT Sertifikasi Nusantara');
    await drawer(page).getByLabel('Teal').check();
    await drawer(page).locator('select').last().selectOption({ label: 'Managed Vault' });
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'ISMS2 created');
    await expect(row(page, 'ISMS2')).toContainText('Setup');
    await expect(row(page, 'ISMS2')).toContainText('Not assigned');
    await expect(row(page, 'ISMS2')).toContainText('Managed Vault');

    await row(page, 'ISMS2').locator('button', { hasText: 'Start implementation' }).click();
    await dialog(page).locator('button', { hasText: 'Start implementation' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Assign at least one Management System Manager before the system moves to implementing.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Cancel' }).click();

    // People and roles is M2-10's screen; the grant goes through the api here.
    await apiWrite(page, baseURL, 'POST', `/api/v1/admin/management-systems/${await systemId(page, baseURL, 'isms2')}/roles`, { user: 'bagus', role: 'ms_manager', isPrimary: true });
    await page.reload();
    await go(page, 'Management systems');
    await expect(row(page, 'ISMS2')).toContainText('Bagus Prasetyo');
    await row(page, 'ISMS2').locator('button', { hasText: 'Start implementation' }).click();
    await dialog(page).locator('button', { hasText: 'Start implementation' }).click();
    await expectToast(page, 'ISMS2 is implementing');
    await expect(row(page, 'ISMS2')).toContainText('Implementing');

    await signIn(page, baseURL, 'bagus', 'tst');
    await openApp(page);
    await switchMs(page, 'ISMS2');
    await go(page, 'Controls & requirements');
    await expect.poll(() => chipCount(page, 'All'), { timeout: 15_000 }).toBe(123);
    await chip(page, 'All').click();
    await expect(page.locator('main')).toContainText('Clauses 4 to 10');
  });

  test('Edit changes the scope and colour; Archive needs the code typed', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await apiWrite(page, baseURL, 'POST', '/api/v1/admin/management-systems', {
      slug: 'qms', code: 'QMS', name: 'Quality management system', packId: 'ISO9001-2015', edition: '2015', scopeStatement: 'Software development', defaultRepository: 'vault', color: '#2e7fb8',
    });
    await openApp(page);
    await go(page, 'Management systems');
    await darkTheme(page);
    // The New management system form in the dark theme (the create test checks it in light).
    await ui.pageAction(page, 'New management system').click();
    await expect(drawer(page)).toContainText('New management system');
    await drawer(page).locator('select').first().selectOption('ISO27001-2022');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    // The refusal of Start implementation in the dark theme: QMS has no MS Manager yet.
    await row(page, 'QMS').locator('button', { hasText: 'Start implementation' }).click();
    await dialog(page).locator('button', { hasText: 'Start implementation' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Assign at least one Management System Manager before the system moves to implementing.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await row(page, 'ISMS').locator('button', { hasText: 'Edit' }).click();
    await expect(drawer(page)).toContainText('Edit ISMS');
    await field(page, 'scopeStatement').fill('Hospital information systems and the data centre');
    await drawer(page).getByLabel('Slate').check();
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'ISMS saved');

    await row(page, 'QMS').locator('button', { hasText: 'Archive' }).click();
    const confirm = dialog(page).locator('button', { hasText: /^Archive$/ });
    await expect(confirm).toBeDisabled();
    await dialog(page).locator('input').fill('QMS');
    await expectOverlayReadable(page);
    await confirm.click();
    await expectToast(page, 'QMS archived');
    await expect(rows(page).last()).toContainText('Archived');
  });

  test.describe('edition transition', () => {
    test.use({ apiSession: 'rina' });
    test('an MS Manager starts an edition transition on the Framework library; finishing waits for the transition audit', async ({ page }) => {
      await openApp(page);
      await go(page, 'Framework library');
      await ui.pageAction(page, 'Edition transition').click();
      await expect(drawer(page)).toContainText('Entries keep pointing at the old edition during and after the transition.');
      // The demo QMS is certified on ISO 9001:2015 with the 2026 edition installed.
      const qms = drawer(page).locator('section[aria-label="QMS"]');
      await expect(qms).toContainText('ISO 9001 2015');
      await expectOverlayReadable(page);
      await qms.locator('button', { hasText: 'Start edition transition' }).click();
      await expectToast(page, 'QMS is transitioning to ISO 9001:2026');
      await expect(qms).toContainText('Transition to 2026 in progress');
      await qms.locator('button', { hasText: 'Finish transition' }).click();
      await expect(qms.locator('[role="alert"]')).toContainText('Record the transition audit with a recommended outcome before completing the transition.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toHaveCount(0);

      // The same drawer in the dark theme, with the transition in progress and the refusal shown.
      await darkTheme(page);
      await ui.pageAction(page, 'Edition transition').click();
      await expect(drawer(page)).toContainText('Entries keep pointing at the old edition during and after the transition.');
      await expect(qms).toContainText('Transition to 2026 in progress');
      await qms.locator('button', { hasText: 'Finish transition' }).click();
      await expect(qms.locator('[role="alert"]')).toContainText('Record the transition audit with a recommended outcome before completing the transition.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toHaveCount(0);
    });
  });

  test.describe('as a Tenant Admin without a business role', () => {
    test.use({ apiSession: 'tenant.admin' });
    test('the Framework library is shown without Edition transition', async ({ page }) => {
      // tenant.admin holds ms.admin in tst but no business role, so ms.transition in no system.
      await page.goto('/');
      await expect(ui.nav(page, 'Management systems')).toHaveCount(1);
      await go(page, 'Framework library');
      // The library's own page action is there, so the page actions have rendered.
      await expect(ui.pageAction(page, 'Import offline bundle')).toBeVisible();
      await expect(ui.pageAction(page, 'Edition transition')).toHaveCount(0);
    });
  });

  test.describe('as the internal auditor', () => {
    test.use({ apiSession: 'maya' });
    test('neither Management systems nor Routing rules is offered', async ({ page }) => {
      await openApp(page);
      await expect(ui.nav(page, 'Management systems')).toHaveCount(0);
      await expect(ui.nav(page, 'Routing rules')).toHaveCount(0);
    });
  });
});
