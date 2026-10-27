import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// The Licence screen against the api (MILESTONE-2 M2-01): GET /license for whoever holds license.read, and
// PUT /admin/license for whoever holds license.manage (rina, Tenant Admin of the single-tenancy stack). The api checks
// the signature and the binding, so a licence of another organisation is refused with LIC-BINDING (D-15).
const LICENCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/pack-tools/dev-licences');
const dialog = (page) => ui.modal(page);
const installButton = (page) => dialog(page).locator('button', { hasText: /^Install licence$/ });

test.describe('Licence against the api @api-only', () => {
  test('a Tenant Admin sees the licence and installs one; a licence of another organisation is refused', async ({ page }) => {
    await openApp(page);
    await go(page, 'Licence');
    const main = page.locator('main');
    await expect(main).toContainText('LIC-DEMO-NDT');
    await expect(main).toContainText('PT Nusantara Digital Teknologi');
    await expect(main.locator('.mx-badge')).toHaveText(['Valid']);
    await expect(main).toContainText('31 Mar 2027');
    await expect(main).toContainText(/\d+ of 150 active members/);
    await expect(main).toContainText('Ed25519, key');
    await expect(main).toContainText('verified');

    await ui.pageAction(page, 'Install licence').click();
    await dialog(page).locator('textarea').fill(readFileSync(path.join(LICENCES, 'LIC-DEMO-TST.json'), 'utf8'));
    await installButton(page).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('The licence is not for this installation or organisation');
    await expect(dialog(page).locator('textarea')).toHaveAttribute('aria-invalid', 'true');
    await expectOverlayReadable(page);

    await dialog(page).locator('input[type="file"]').setInputFiles(path.join(LICENCES, 'LIC-DEMO-NDT.json'));
    await expect(dialog(page).locator('textarea')).toHaveValue(/"license_id": "LIC-DEMO-NDT"/);
    await installButton(page).click();
    await expectToast(page, 'Licence installed');
    await expect(dialog(page)).toHaveCount(0);
    await expect(main).toContainText('LIC-DEMO-NDT');
  });

  test.describe('as the internal auditor', () => {
    test.use({ apiSession: 'maya' });
    test('the Licence screen is not in the sidebar without license.read', async ({ page }) => {
      await openApp(page);
      await expect(ui.nav(page, 'Licence')).toHaveCount(0);
      await expect(ui.nav(page, 'Storage repositories')).toHaveCount(0);
    });
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('the licence is shown without Install licence', async ({ page }) => {
      await openApp(page);
      await go(page, 'Licence');
      await expect(page.locator('main')).toContainText('LIC-DEMO-NDT');
      await expect(page.locator('main button[title="Install licence"]')).toHaveCount(0);
    });
  });
});
