import {
  test, expect, ui, go, openApp, openScreen, openRow, switchMs, switchRole, closeDrawer, expectToast, expectOverlayReadable, expectReadableText,
  expectNoHorizontalOverflow, drawerAction, metaById,
} from '../helpers.js';

// Required documented information of the sample build (MILESTONE-2 M2-12): the rows of the sample ISMS per clause with
// the document or evidence that covers each, the filter Missing only and the sidebar badge, the scope panel of H.9
// (Register from template, then the approved scope statement with its version and date after the owner uploads it and
// the manager approves it), Link existing document and Remove link, the same for the template code PRC-04 that only
// records to retain name (activity 4.1 expects it, BR-40), the scope panel of a system whose clause 4.3 is implemented
// by its policy (not a scope statement), and the read-only view of the auditor.
// @sample-only: the API project covers the screen in e2e/api-only/documented-info.spec.js.
const meta = metaById('documented-info');
const main = (page) => page.locator('main');
const scope = (page) => main(page).locator('[data-scope]');
const row = (page, code) => main(page).locator('tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp(`^${code}$`) }) });
const button = (scopeEl, name) => scopeEl.locator('button', { hasText: new RegExp(`^${name}$`) });
const dialog = (page) => ui.modal(page).last();

test.describe('Required documented information @sample-only', () => {
  test('lists the documented information per clause with the scope panel, Missing only and the badge', async ({ page }) => {
    await openScreen(page, meta);
    await expect(ui.title(page)).toHaveText('Required documented information');
    await expect(main(page)).toContainText('Implementation');
    await expect(ui.nav(page, 'Required documented information')).toContainText('13');
    await expect(main(page).locator('.mx-card-title')).toHaveText([
      'Scope', 'Clause 4, Context of the organisation', 'Clause 5, Leadership', 'Clause 6, Planning', 'Clause 7, Support', 'Clause 8, Operation',
      'Clause 9, Performance evaluation', 'Clause 10, Improvement',
    ]);
    await expect(main(page)).toContainText('15 items, 13 missing');
    await expect(main(page).locator('[data-scope-text]')).toHaveText('Data centre & managed services operations: Jakarta and Surabaya');
    await expect(scope(page)).toContainText('No approved scope statement');
    await expect(row(page, 'DI-02')).toContainText('POL-01');
    await expect(row(page, 'DI-02')).toContainText('Approved');
    await expect(row(page, 'DI-05')).toContainText('Draft');
    await expect(row(page, 'DI-06')).toContainText('Missing');
    await expect(row(page, 'DI-06').locator('button')).toHaveText(['Register from template', 'Link existing document']);
    await expect(row(page, 'DI-12')).toContainText('Record to retain');
    await main(page).getByText('Missing only').click();
    await expect(main(page).locator('tbody tr')).toHaveCount(13);
    await expect(row(page, 'DI-02')).toHaveCount(0);
    await expectReadableText(page, 4.5);
    await expectNoHorizontalOverflow(page);
    await main(page).getByText('Missing only').click();
    await row(page, 'DI-02').locator('button', { hasText: 'POL-01' }).click();
    await expect(ui.title(page)).toHaveText('Document register');
    await expect(ui.drawer(page)).toContainText('Information Security Policy');
  });

  test('the scope statement is registered from its template, uploaded by the owner and approved by the manager (H.9)', async ({ page }) => {
    await openScreen(page, meta);
    await button(scope(page), 'Register from template').click();
    const form = ui.drawer(page);
    await expect(form).toContainText('New document');
    await expect(form.getByLabel(/^Document code/)).toHaveValue('SCO-01');
    await expect(form.getByLabel(/^Title/)).toHaveValue('Scope of the ISMS');
    await expect(form.getByLabel(/^Document type/)).toHaveValue('policy');
    await form.getByLabel(/^Owner/).selectOption('bagus');
    await expectOverlayReadable(page);
    await button(form, 'Register document').click();
    await expectToast(page, 'SCO-01 registered as a draft. Attach its first version from the document.');
    await expect(scope(page)).toContainText('SCO-01 is registered and its state is draft.');
    await expect(row(page, 'DI-01')).toContainText('SCO-01');
    await expect(row(page, 'DI-01')).toContainText('Draft');
    await expect(ui.nav(page, 'Required documented information')).toContainText('12');

    await switchRole(page, 'Domain Owner');
    await go(page, 'Document register');
    await openRow(page, 'SCO-01');
    await ui.drawer(page).locator('[data-docs-edit] button', { hasText: 'Attach first version' }).click();
    await ui.modal(page).locator('button', { hasText: 'Backup-Job-Log-Sep-2026.xlsx' }).click();
    await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
    await dialog(page).locator('textarea').fill('Scope of the ISMS for both data centres');
    await dialog(page).locator('button', { hasText: 'Submit for review' }).click();
    await expectToast(page, 'SCO-01 v1.0 submitted for review');
    await closeDrawer(page);

    await switchRole(page, 'MS Manager');
    await go(page, 'Document register');
    await openRow(page, 'SCO-01');
    await drawerAction(page, 'Open review').click();
    await dialog(page).locator('button', { hasText: 'Approve' }).click();
    await expectToast(page, 'SCO-01 v1.0 approved');
    await closeDrawer(page);
    await go(page, 'Required documented information');
    await expect(scope(page)).toHaveAttribute('data-scope', 'approved');
    await expect(scope(page)).toContainText('SCO-01');
    await expect(scope(page)).toContainText('v1.0');
    await expect(scope(page)).toContainText('29 Sep 2026');
    await expect(row(page, 'DI-01')).toContainText('Approved');
  });

  test('Link existing document makes a document of the customer stand for the pack code, and Remove link undoes it', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'DI-06').locator('button', { hasText: 'Link existing document' }).click();
    await expect(dialog(page)).toContainText('Link a document to PLN-01');
    await button(dialog(page), 'Link document').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose a document first.');
    await dialog(page).locator('input[type="search"]').fill('ICT');
    await dialog(page).locator('[role="option"]', { hasText: 'PLN-02' }).click();
    await expectOverlayReadable(page);
    await button(dialog(page), 'Link document').click();
    await expectToast(page, 'PLN-02 now stands for PLN-01');
    await expect(row(page, 'DI-06')).toContainText('PLN-02');
    await expect(row(page, 'DI-06')).toContainText('Linked to PLN-01');
    await expect(row(page, 'DI-06')).toContainText('In review');
    await expect(row(page, 'DI-06').locator('button', { hasText: /link/i })).toHaveText(['Change link', 'Remove link']);
    await expect(ui.nav(page, 'Required documented information')).toContainText('12');
    await row(page, 'DI-06').locator('button', { hasText: 'Remove link' }).click();
    await expect(dialog(page)).toContainText('PLN-02 no longer stands for PLN-01.');
    await button(dialog(page), 'Remove link').click();
    await expectToast(page, 'The link of PLN-01 was removed');
    await expect(row(page, 'DI-06')).toContainText('Missing');
    await expect(ui.nav(page, 'Required documented information')).toContainText('13');
  });

  test('records to retain that name PRC-04 offer Register from template and Link existing document for that code (BR-40)', async ({ page }) => {
    await openScreen(page, meta);
    await expect(row(page, 'DI-03')).toContainText('Record to retain');
    await expect(row(page, 'DI-03')).toContainText('PRC-04');
    await expect(row(page, 'DI-03').locator('button', { hasText: /^(Register from template|Link existing document)$/ })).toHaveText([
      'Register from template', 'Link existing document',
    ]);
    // No activity expects REG-01 and no document to maintain names it: a link could not be shown after a new page load.
    await expect(row(page, 'DI-07').locator('button')).toHaveText(['Register from template']);
    await row(page, 'DI-03').locator('button', { hasText: 'Register from template' }).click();
    const form = ui.drawer(page);
    await expect(form.getByLabel(/^Document code/)).toHaveValue('PRC-04');
    await expect(form.getByLabel(/^Title/)).toHaveValue('Information security risk assessment process');
    await expect(form.getByLabel(/^Document type/)).toHaveValue('procedure');
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);

    const state = await row(page, 'DI-03').locator('td').nth(5).innerText();
    await row(page, 'DI-03').locator('button', { hasText: 'Link existing document' }).click();
    await expect(dialog(page)).toContainText('Link a document to PRC-04');
    await dialog(page).locator('input[type="search"]').fill('PRC-05');
    await dialog(page).locator('[role="option"]', { hasText: 'PRC-05' }).click();
    await expectOverlayReadable(page);
    await button(dialog(page), 'Link document').click();
    await expectToast(page, 'PRC-05 now stands for PRC-04');
    for (const code of ['DI-03', 'DI-04']) {
      await expect(row(page, code).locator('[data-template-doc]')).toContainText('PRC-05');
      await expect(row(page, code)).toContainText('Linked to PRC-04');
      await expect(row(page, code).locator('button', { hasText: /link/i })).toHaveText(['Change link', 'Remove link']);
    }
    // The record keeps the state of its evidence, so the badge does not change.
    await expect(row(page, 'DI-03').locator('td').nth(5)).toHaveText(state);
    await expect(ui.nav(page, 'Required documented information')).toContainText('13');
    await expectReadableText(page, 4.5);
    await row(page, 'DI-04').locator('button', { hasText: 'Remove link' }).click();
    await expect(dialog(page)).toContainText('PRC-05 no longer stands for PRC-04.');
    await button(dialog(page), 'Remove link').click();
    await expectToast(page, 'The link of PRC-04 was removed');
    await expect(row(page, 'DI-03').locator('[data-template-doc]')).toHaveCount(0);
    await expect(row(page, 'DI-03').locator('button', { hasText: 'Link existing document' })).toBeVisible();
  });

  test('the policy that implements clause 4.3 of the ABMS is not its scope statement (H.9)', async ({ page }) => {
    await openApp(page);
    await switchMs(page, 'ABMS');
    await go(page, 'Required documented information');
    await expect(row(page, 'DI-01')).toContainText('POL-A01');
    await expect(row(page, 'DI-01')).toContainText('Draft');
    await expect(row(page, 'DI-01').locator('button', { hasText: /^(Register from template|Link existing document)$/ })).toHaveText([
      'Register from template', 'Link existing document',
    ]);
    await expect(scope(page)).toHaveAttribute('data-scope', 'none');
    await expect(scope(page)).toContainText('No approved scope statement');
    await expect(scope(page)).not.toContainText('POL-A01');
    await button(scope(page), 'Link existing document').click();
    await expect(dialog(page)).toContainText('Link a document to SCO-A01');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await button(scope(page), 'Register from template').click();
    await expect(ui.drawer(page).getByLabel(/^Document code/)).toHaveValue('SCO-A01');
  });

  test('an auditor reads the list without the actions of document control', async ({ page }) => {
    await page.goto('/?screen=documented-info&persona=auditor');
    await expect(ui.title(page)).toHaveText('Required documented information');
    await expect(main(page).locator('[data-screen="documented-info"]')).toBeVisible();
    await expect(row(page, 'DI-06')).toContainText('Missing');
    await expect(main(page).locator('th', { hasText: 'Actions' })).toHaveCount(0);
    await expect(main(page).locator('button', { hasText: 'Register from template' })).toHaveCount(0);
    await expect(scope(page)).toContainText('No approved scope statement');
  });

  for (const theme of ['light', 'dark']) {
    test(`the screen, New document and the link dialog are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(main(page)).toContainText('Klausul 4, Konteks organisasi');
      await expect(row(page, 'DI-09')).toContainText('Rekaman bahwa proses telah dilaksanakan sesuai rencana');
      expect(await main(page).innerText()).not.toMatch(/\bshowing\b/);
      await expectReadableText(page, 4.5);
      await button(scope(page), 'Daftarkan dari templat').click();
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await expect(ui.drawer(page)).toHaveCount(0);
      await row(page, 'DI-06').locator('button', { hasText: 'Tautkan dokumen yang ada' }).click();
      await expectOverlayReadable(page);
    });
  }
});
