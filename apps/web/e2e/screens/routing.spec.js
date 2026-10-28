import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Routing rules of the sample build (MILESTONE-2 M2-09): the sample organisation's default rules and two changes
// waiting for approval, "Add rule" with the BR-38 confirmation, "Edit", "Approve" and "Reject" (never by the person
// who asked), and the "Stored files" tab. @sample-only: the API project covers the screen in
// e2e/api-only/routing.spec.js.
const meta = metaById('routing');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rules = (page) => page.locator('main table tbody tr');
const rule = (page, ...texts) => texts.reduce((loc, t) => loc.filter({ hasText: t }), rules(page));
const select = (page, label) => drawer(page).getByLabel(new RegExp(`^${label}`));
const saveButton = (page) => drawer(page).locator('button', { hasText: /^Save$/ });

test.describe('Routing rules @sample-only', () => {
  test('lists the rules, waiting changes first, with who asked and who may decide', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('Routing rules');
    await expect(main).toContainText('2 routing changes are waiting for approval.');
    await expect(rules(page)).toHaveCount(6);
    await expect(rules(page).nth(0)).toContainText('Waiting for approval');
    await expect(rules(page).nth(0)).toContainText('Requested by Tono Hartono');
    await expect(rule(page, 'ISMS', 'Link')).toContainText('Active');
    await expect(rule(page, 'BCMS', 'Zero-transit')).toContainText('Internal to Link');
    const own = rule(page, 'Confidential');
    await expect(own).toContainText('You asked for this change; another Tenant Admin decides on it.');
    await expect(own.locator('button', { hasText: 'Approve' })).toBeDisabled();
    await expect(own.locator('button', { hasText: 'Reject' })).toBeDisabled();
    await expect(own.locator('button', { hasText: 'Edit' })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('another person approves a waiting change, which replaces the active rule of its scope', async ({ page }) => {
    await openScreen(page, meta);
    const waiting = rule(page, 'Restricted', 'Evidence');
    await waiting.locator('button', { hasText: 'Approve' }).click();
    await expectToast(page, 'Routing change approved and active');
    await expect(waiting).toContainText('Active');
    await expect(waiting).toContainText('Decided by Rina Kusuma');
    await expect(page.locator('main')).toContainText('1 routing change is waiting for approval.');
  });

  test('Add rule asks for the BR-38 confirmation before restricted files go to the provider cloud vault', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Add rule').click();
    await expect(drawer(page)).toContainText('Add a routing rule');
    await expectOverlayReadable(page);
    await select(page, 'System').selectOption({ label: 'QMS' });
    await select(page, 'Classification of the file').selectOption({ label: 'Restricted' });
    await select(page, 'File kind').selectOption({ label: 'Documents' });
    await select(page, 'Repository').selectOption({ label: 'Managed Vault' });
    await expect(select(page, 'Storage mode')).toHaveValue('stored');
    await drawer(page).locator('input[name="priority"]').fill('99999');
    await saveButton(page).click();
    await expect(drawer(page)).toContainText('Enter a whole number from 0 to 32767.');
    await drawer(page).locator('input[name="priority"]').fill('20');
    await drawer(page).locator('textarea[name="note"]').fill('Restricted QMS documents to the vault');
    await saveButton(page).click();
    await expect(dialog(page)).toContainText('Second approval needed');
    await expect(dialog(page)).toContainText("Restricted files will be stored in the provider's cloud. This change needs a second approval.");
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Send for approval' }).click();
    await expectToast(page, 'Routing change waiting for approval by another Tenant Admin');
    await expect(drawer(page)).toHaveCount(0);
    const added = rule(page, 'QMS', 'Restricted');
    await expect(added).toContainText('Waiting for approval');
    await expect(added).toContainText('Restricted QMS documents to the vault');
    await expect(added).toContainText('You asked for this change');
  });

  test('Edit changes an active rule; Reject asks first and keeps the change out', async ({ page }) => {
    await openScreen(page, meta);
    const active = rule(page, 'ISMS', 'Restricted to Zero-transit');
    await active.locator('button', { hasText: 'Edit' }).click();
    await expect(drawer(page)).toContainText('Edit routing rule');
    await expect(select(page, 'System')).toBeDisabled();
    await saveButton(page).click();
    await expect(drawer(page)).toContainText('Nothing changed.');
    await select(page, 'Storage mode').selectOption({ label: 'Pass-through' });
    await saveButton(page).click();
    await expectToast(page, 'Routing rule saved');
    await expect(active).toContainText('Pass-through');

    const waiting = rule(page, 'Restricted', 'Evidence');
    await waiting.locator('button', { hasText: 'Reject' }).click();
    await expect(dialog(page)).toContainText('Reject routing change');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Routing change rejected');
    await expect(waiting).toContainText('Rejected');
  });

  test('Stored files lists the files of every repository with their hash and check, and filters them', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main [role="tab"]', { hasText: 'Stored files' }).click();
    const files = page.locator('main table tbody tr');
    await expect(page.locator('main')).toContainText('name, place and hash only, never the content');
    await expect(files).toHaveCount(50);
    await expect(page.locator('main')).toContainText(/50 of \d+ files/);
    await page.locator('main select').first().selectOption({ label: 'Google Shared Drive' });
    await expect(files.first()).toContainText('Google Shared Drive');
    await expect(files.first()).toContainText('BCMS');
    await page.locator('main select').nth(1).selectOption({ label: 'Check pending' });
    await expect(files.first()).toContainText('Check pending');
    await page.locator('main select').first().selectOption({ label: 'All repositories' });
    await page.locator('main select').nth(1).selectOption({ label: 'Missing' });
    await expect(files.first()).toContainText('Missing');
    await expectReadableText(page, 4.5);
  });

  for (const theme of ['light', 'dark']) {
    test(`the rule form and the confirmation are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(page.locator('main')).toContainText('Diminta oleh Tono Hartono');
      await ui.pageAction(page, 'Tambah aturan').click();
      await expect(drawer(page)).toContainText('Tambah aturan routing');
      await select(page, 'Repositori').selectOption({ label: 'Managed Vault' });
      await drawer(page).locator('button', { hasText: /^Simpan$/ }).click();
      await expect(dialog(page)).toContainText('Perlu persetujuan kedua');
      await expectOverlayReadable(page);
      await dialog(page).locator('button', { hasText: 'Batal' }).click();
      await expectOverlayReadable(page);
    });
  }
});
