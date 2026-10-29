import { test, expect, ui, go, openApp } from '../helpers.js';

// Getting started against the api (MILESTONE-2 M2-16, D.5): `GET /admin/onboarding` for a Tenant Admin. tenant.admin
// holds no business role in the Test Organisation, so it lands here and the steps of the MS Manager name Rina Kusuma,
// the primary MS Manager of its ISMS, with a prepared email. rina is a Tenant Admin and an MS Manager of every system
// of PT Nusantara Digital Teknologi: she is the only administrator there, and does the manager's steps herself.
test.describe('Getting started against the api @api-only', () => {
  test.describe('as a Tenant Admin without a business role', () => {
    test.use({ apiSession: 'tenant.admin' });

    test('lands on Getting started, sees the steps and emails the steps of the MS Manager to that manager', async ({ page }) => {
      await page.goto('/');
      await expect(ui.title(page)).toHaveText('Getting started');
      const main = page.locator('main');
      await expect(main.locator('.mx-gs-progress')).toHaveText(/^(\d+ of \d+ steps done|Every step is done)$/);
      await expect(main.locator('li[data-step="licence"]')).toContainText('Done');
      await expect(main.locator('li[data-step="licence"]')).toContainText(/\d+ of 150 seats in use/);
      // rina and tenant.admin are the two Tenant Admins of the Test Organisation: no single administrator warning.
      await expect(main.locator('li[data-step="second_admin"]')).toContainText('Administrators: 2');
      await expect(main).not.toContainText('You are the only administrator');
      await expect(main).toContainText('ISMS');
      await expect(main).toContainText('For the Management System Manager');
      await expect(main.locator('li[data-step="audit_dates"]')).toContainText('Assigned to Rina Kusuma');
      const pending = main.locator('li[data-step][data-state="pending"] a[href^="mailto:rina.kusuma@nusantaradigital.co.id?"]');
      if (await pending.count()) await expect(pending.first()).toHaveText('Email Rina Kusuma');
      // A step's button opens the screen that completes it.
      await main.locator('li[data-step="licence"] button', { hasText: 'Open Licence' }).click();
      await expect(ui.title(page)).toHaveText('Licence');
      await expect(page.locator('main')).toContainText('LIC-DEMO-TST');
      await go(page, 'Getting started');
      await expect(ui.nav(page, 'Getting started')).toHaveCSS('font-weight', '600');
    });
  });

  test.describe('as a Tenant Admin who manages the systems', () => {
    test('rina sees the single administrator warning and opens the steps of the MS Manager herself', async ({ page }) => {
      await openApp(page);
      const labels = await page.locator('aside nav button').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
      expect(labels.indexOf('Getting started')).toBeGreaterThan(-1);
      expect(labels.indexOf('Getting started')).toBeLessThan(labels.indexOf('Framework library'));
      await go(page, 'Getting started');
      const main = page.locator('main');
      await expect(main).toContainText('You are the only administrator');
      await expect(main).toContainText('Role grants to yourself and to other administrators wait until a second administrator approves them');
      await expect(main.locator('li[data-step="second_admin"]')).toContainText('To do');
      await expect(main.locator('a[href^="mailto:"]')).toHaveCount(0);
      const audit = main.locator('li[data-step="audit_dates"]').first();
      await expect(audit.locator('button', { hasText: 'Open Certification timeline' })).toBeVisible();
      await audit.locator('button', { hasText: 'Open Certification timeline' }).click();
      await expect(ui.title(page)).toHaveText('Certification timeline');
    });
  });

  test.describe('as the internal auditor', () => {
    test.use({ apiSession: 'maya' });
    test('Getting started is not in the sidebar without ms.admin', async ({ page }) => {
      await openApp(page);
      await expect(ui.nav(page, 'Getting started')).toHaveCount(0);
      expect((await page.request.get('/api/v1/admin/onboarding')).status()).toBe(403);
    });
  });
});
