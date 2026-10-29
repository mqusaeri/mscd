import {
  test, expect, ui, go, openApp, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Management systems of the sample build (MILESTONE-2 M2-09): the sample systems with their edition, status, primary
// manager and default repository, "New management system" with the beta notice of pre-release packs, "Edit", "Start
// implementation" (refused without an MS Manager) and "Archive" with a typed confirmation. @sample-only: the API
// project creates an ISO/IEC 27001 system in e2e/api-only/systems.spec.js.
const meta = metaById('systems');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, code) => rows(page).filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${code}$`) }) });
const field = (page, name) => drawer(page).locator(`[name="${name}"]`);
const saveButton = (page) => drawer(page).locator('button', { hasText: /^Save$/ });

test.describe('Management systems @sample-only', () => {
  test('lists the systems with standard, edition, status, primary manager and default repository', async ({ page }) => {
    await openScreen(page, meta);
    await expect(page.locator('main h1')).toHaveText('Management systems');
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, 'ISMS')).toContainText('ISO/IEC 27001 2022');
    await expect(row(page, 'ISMS')).toContainText('Certified');
    await expect(row(page, 'ISMS')).toContainText('Rina Kusuma');
    await expect(row(page, 'ISMS')).toContainText('SharePoint Online');
    await expect(row(page, 'QMS')).toContainText('ISO 9001 2015, in transition to 2026');
    await expect(row(page, 'QMS')).toContainText('Edition transition');
    await expect(row(page, 'ABMS')).toContainText('Setup');
    await expect(row(page, 'ABMS').locator('button', { hasText: 'Start implementation' })).toBeVisible();
    await expect(row(page, 'ISMS').locator('button', { hasText: 'Start implementation' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('New management system checks the fields, shows the beta notice and creates the system in setup', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'New management system').click();
    await expect(drawer(page)).toContainText('The entries of the standard are created with the system');
    await expectOverlayReadable(page);
    await saveButton(page).click();
    for (const name of ['code', 'slug', 'name', 'scopeStatement']) await expect(field(page, name)).toHaveAttribute('aria-invalid', 'true');
    await drawer(page).locator('select').first().selectOption('ISO37001-2025');
    await expect(drawer(page)).toContainText('Beta, pre-release');
    await expect(drawer(page)).toContainText('This pack is a pre-release');
    await expectOverlayReadable(page);
    await drawer(page).locator('select').first().selectOption('ISO27001-2022');
    await expect(drawer(page)).not.toContainText('This pack is a pre-release');
    await field(page, 'code').fill('ISMS2');
    await expect(field(page, 'slug')).toHaveValue('isms2');
    await field(page, 'name').fill('Information security, Surabaya site');
    await field(page, 'scopeStatement').fill('Managed services operations at the Surabaya data centre');
    await drawer(page).getByLabel('Teal').check();
    await saveButton(page).click();
    await expectToast(page, 'ISMS2 created with 123 entries');
    await expect(drawer(page)).toHaveCount(0);
    await expect(row(page, 'ISMS2')).toContainText('Setup');
    await expect(row(page, 'ISMS2')).toContainText('Not assigned');
    await expect(page.locator('main')).toContainText('Grant the Management System Manager role (primary) in People and roles before the system starts implementing.');

    await row(page, 'ISMS2').locator('button', { hasText: 'Start implementation' }).click();
    await expect(dialog(page)).toContainText('ISMS2 moves from setup to implementing.');
    await dialog(page).locator('button', { hasText: 'Start implementation' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Assign at least one Management System Manager before the system moves to implementing.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Cancel' }).click();
    await expect(row(page, 'ISMS2')).toContainText('Setup');
  });

  test('Start implementation moves a system with a manager; Edit changes scope, body, colour and repository', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'ABMS').locator('button', { hasText: 'Start implementation' }).click();
    await dialog(page).locator('button', { hasText: 'Start implementation' }).click();
    await expectToast(page, 'ABMS is implementing');
    await expect(row(page, 'ABMS')).toContainText('Implementing');

    await row(page, 'ISMS').locator('button', { hasText: 'Edit' }).click();
    await expect(drawer(page)).toContainText('Edit ISMS');
    await expect(field(page, 'code')).toHaveCount(0);
    await saveButton(page).click();
    await expect(drawer(page)).toContainText('Nothing changed.');
    await field(page, 'scopeStatement').fill('Data centre, managed services and the Surabaya office');
    await field(page, 'certificationBody').fill('');
    await drawer(page).getByLabel('Slate').check();
    await drawer(page).locator('select').selectOption({ label: 'Managed Vault' });
    await expectOverlayReadable(page);
    await saveButton(page).click();
    await expectToast(page, 'ISMS saved');
    await expect(row(page, 'ISMS')).toContainText('Managed Vault');
  });

  test('Archive needs the code typed, then the system stays listed last without actions', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'ABMS').locator('button', { hasText: 'Archive' }).click();
    await expect(dialog(page)).toContainText('ABMS keeps its data, but nothing in it changes any more.');
    const confirm = dialog(page).locator('button', { hasText: /^Archive$/ });
    await expect(confirm).toBeDisabled();
    await dialog(page).locator('input').fill('ABMS');
    await expectOverlayReadable(page);
    await confirm.click();
    await expectToast(page, 'ABMS archived');
    await expect(rows(page).last()).toContainText('Archived');
    await expect(row(page, 'ABMS').locator('button')).toHaveCount(0);
  });

  test('the Framework library keeps its single page action in the sample build', async ({ page }) => {
    await openApp(page);
    await go(page, 'Framework library');
    await expect(page.locator('main > div > div:first-child button[title]')).toHaveText(['Check for updates']);
    await expect(ui.pageAction(page, 'Edition transition')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`the form is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(row(page, 'QMS')).toContainText('dalam transisi ke 2026');
      await ui.pageAction(page, 'Sistem manajemen baru').click();
      await drawer(page).locator('select').first().selectOption('ISO9001-2026');
      await expect(drawer(page)).toContainText('Paket ini pra-rilis');
      await drawer(page).locator('button', { hasText: /^Simpan$/ }).click();
      await expect(drawer(page)).toContainText('Isi kolom ini.');
      await expectOverlayReadable(page);
    });
  }
});
