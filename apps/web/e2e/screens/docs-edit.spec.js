import {
  test, expect, ui, go, openApp, openRow, listRow, switchRole, closeDrawer, expectToast, expectOverlayReadable, drawerAction,
} from '../helpers.js';

// The document control forms of the sample build (MILESTONE-2 M2-12): a new version goes to In review as on a live
// install, its author cannot approve it and another persona approves it in the review panel; Return to draft keeps
// its note for the author; New document checks its fields and opens the new draft; Edit of a shared document asks for
// the BR-22 confirmation; Change owner or approver shows BR-16 before Save; Reassign asks for a person (BR-17).
// The claims open their forms in place of the Milestone 1 toasts. @sample-only: the API project covers the forms in
// e2e/api-only/docs-edit.spec.js.
const panel = (page) => ui.drawer(page).locator('[data-docs-edit]');
const panelButton = (page, name) => panel(page).locator('button', { hasText: new RegExp(`^${name}$`) });
const dialog = (page) => ui.modal(page).last();
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

/** Picks the first file of the sample SharePoint picker for the document. */
async function pickFile(page) {
  await expect(ui.modal(page)).toContainText('Select document file from repository');
  await ui.modal(page).locator('button', { hasText: 'Backup-Job-Log-Sep-2026.xlsx' }).click();
  await ui.modal(page).locator('button', { hasText: 'Link selected file' }).click();
}

test.describe('Document control forms @sample-only', () => {
  test('the owner uploads a new version with a change summary, cannot approve it, and the manager approves it', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await go(page, 'Document register');
    await openRow(page, 'STD-05');
    await expect(panel(page).locator('button')).toHaveText(['Actions', 'Versions', 'Upload with change summary']);
    await panelButton(page, 'Upload with change summary').click();
    await pickFile(page);
    await expect(dialog(page)).toContainText('New version of STD-05');
    await expect(dialog(page)).toContainText('Backup-Job-Log-Sep-2026.xlsx');
    await expectOverlayReadable(page);
    await dialog(page).locator('textarea').fill('Firewall log retention raised to 12 months');
    await button(dialog(page), 'Submit for review').click();
    await expectToast(page, 'STD-05 v2.0 submitted for review');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(ui.drawer(page)).toContainText('In review');
    await drawerAction(page, 'Open review').click();
    await expect(dialog(page)).toContainText('Review of STD-05');
    await expect(dialog(page)).toContainText('v2.0');
    await expect(dialog(page)).toContainText('Bagus Prasetyo');
    await expect(dialog(page)).toContainText('Firewall log retention raised to 12 months');
    await expect(button(dialog(page), 'Approve')).toBeDisabled();
    await expect(dialog(page)).toContainText('You submitted this version');
    await expect(button(dialog(page), 'Return to draft')).toHaveCount(0);
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(ui.modal(page)).toHaveCount(0);
    await closeDrawer(page);

    await switchRole(page, 'Management System Manager');
    await go(page, 'Document register');
    await openRow(page, 'STD-05');
    await drawerAction(page, 'Open review').click();
    await expect(button(dialog(page), 'Approve')).toBeEnabled();
    await button(dialog(page), 'Approve').click();
    await expectToast(page, 'STD-05 v2.0 approved');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(listRow(page, 'STD-05')).toContainText('Approved');
    await expect(listRow(page, 'STD-05')).toContainText('v2.0');
    await panel(page).locator('[role="tab"]', { hasText: 'Versions' }).click();
    await expect(panel(page).locator('[data-version]')).toHaveCount(2);
    await expect(panel(page).locator('[data-version="2.0"]')).toContainText('Approved by Rina Kusuma');
    await expect(panel(page).locator('[data-version="2.0"]')).toContainText('Firewall log retention raised to 12 months');
    await expect(panel(page).locator('[data-version="1.1"]')).toContainText('Superseded');
  });

  test('Return to draft needs a note, and the author sees it with Continue draft', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'Domain Owner');
    await go(page, 'Document register');
    await openRow(page, 'PRC-10');
    await panelButton(page, 'Upload with change summary').click();
    await pickFile(page);
    await button(dialog(page), 'Submit for review').click();
    await expectToast(page, 'PRC-10 v3.0 submitted for review');
    await closeDrawer(page);

    await switchRole(page, 'Management System Manager');
    await go(page, 'Document register');
    await openRow(page, 'PRC-10');
    await drawerAction(page, 'Open review').click();
    await button(dialog(page), 'Return to draft').click();
    await button(dialog(page), 'Return to draft').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Write what the author must change.');
    await dialog(page).locator('textarea').fill('Add the patch window for servers in Surabaya.');
    await button(dialog(page), 'Return to draft').click();
    await expectToast(page, 'PRC-10 returned to draft');
    await expect(listRow(page, 'PRC-10')).toContainText('Draft');
    await closeDrawer(page);

    await switchRole(page, 'Domain Owner');
    await go(page, 'Document register');
    await openRow(page, 'PRC-10');
    await drawerAction(page, 'Continue draft').click();
    await expect(dialog(page)).toContainText('Draft of PRC-10');
    await expect(dialog(page)).toContainText('Returned to draft');
    await expect(dialog(page)).toContainText('Add the patch window for servers in Surabaya.');
    await expect(button(dialog(page), 'Upload new version')).toBeVisible();
    await expectOverlayReadable(page);
  });

  test('New document checks its fields, registers the draft and opens it with Attach first version', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await ui.pageAction(page, 'New document').click();
    const form = ui.drawer(page);
    await expect(form).toContainText('New document');
    await expect(form).toContainText('Document register, ISMS');
    await button(form, 'Register document').click();
    await expect(form.locator('[role="alert"]')).toHaveText(['Required', 'Required', 'Required', 'Required']);
    // An activity output that no documented information row names: the code and type, while the title stays to be typed.
    await expect(form.getByLabel(/^Start from a template/).locator('option', { hasText: /^PRC-13, output of activity \d+\.\d+ / })).toHaveCount(1);
    await form.getByLabel(/^Start from a template/).selectOption('PRC-13');
    await expect(form.getByLabel(/^Document code/)).toHaveValue('PRC-13');
    await expect(form.getByLabel(/^Document type/)).toHaveValue('procedure');
    await expect(form.getByLabel(/^Title/)).toHaveValue('');
    await form.getByLabel(/^Start from a template/).selectOption('PLN-01');
    await expect(form.getByLabel(/^Document code/)).toHaveValue('PLN-01');
    await expect(form.getByLabel(/^Title/)).toHaveValue('Information security risk treatment plan');
    await expect(form.getByLabel(/^Document type/)).toHaveValue('plan');
    await form.getByLabel(/^Owner/).selectOption('rina');
    await form.getByLabel(/^Approver/).selectOption('rina');
    await expect(form.locator('[data-rule="BR-16"]')).toContainText('The owner is also the approver.');
    await form.getByLabel(/^Approver/).selectOption('hendra');
    await form.getByText('External, issued by someone else').click();
    await button(form, 'Register document').click();
    await expect(form.locator('[role="alert"]')).toHaveText(['Name who issued the external document.']);
    await form.getByLabel(/^Issued by/).fill('Head office risk committee');
    await expectOverlayReadable(page);
    await button(form, 'Register document').click();
    await expectToast(page, 'PLN-01 registered as a draft');
    await expect(listRow(page, 'PLN-01')).toContainText('Draft');
    await expect(ui.drawer(page)).toContainText('Information security risk treatment plan');
    await expect(panel(page)).toContainText('External document');
    await panelButton(page, 'Attach first version').click();
    await pickFile(page);
    await expect(dialog(page)).toContainText('First version of PLN-01');
    await button(dialog(page), 'Submit for review').click();
    await expectToast(page, 'PLN-01 v1.0 submitted for review');
    await expect(listRow(page, 'PLN-01')).toContainText('In review');
  });

  test('a duplicate code stays in the form with the refusal next to the code', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await ui.pageAction(page, 'New document').click();
    const form = ui.drawer(page);
    await form.getByLabel(/^Document code/).fill('POL-01');
    await form.getByLabel(/^Title/).fill('Second policy');
    await form.getByLabel(/^Document type/).selectOption('policy');
    await form.getByLabel(/^Owner/).selectOption('rina');
    await button(form, 'Register document').click();
    await expect(form.locator('[role="alert"]')).toHaveText(['Document POL-01 already exists']);
    await expect(form.getByLabel(/^Title/)).toHaveValue('Second policy');
  });

  test('Edit of a shared document asks first, owner and approver show BR-16, Reassign asks for a person', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await openRow(page, 'IMS-01');
    await panelButton(page, 'Edit').click();
    await expect(dialog(page)).toContainText('Edit IMS-01');
    await dialog(page).getByLabel(/^Title/).fill('Document Control Procedure v4');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('This change also applies to: QMS, BCMS, ABMS. Continue?');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Apply to every system').click();
    await expectToast(page, 'IMS-01 saved');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(listRow(page, 'IMS-01')).toContainText('Document Control Procedure v4');

    await panelButton(page, 'Change owner or approver').click();
    await expect(dialog(page)).toContainText('Owner and approver of IMS-01');
    await dialog(page).getByLabel(/^Approver/).selectOption('rina');
    await expect(dialog(page).locator('[data-rule="BR-16"]')).toContainText('A document cannot be approved by its own author');
    await dialog(page).getByLabel(/^Approver/).selectOption('sari');
    await expect(dialog(page).locator('[data-rule="BR-16"]')).toHaveCount(0);
    await button(dialog(page), 'Save').click();
    await button(dialog(page), 'Apply to every system').click();
    await expectToast(page, 'IMS-01 saved');
    await closeDrawer(page);

    await openRow(page, 'PLN-02');
    await panelButton(page, 'Reassign').click();
    await expect(dialog(page)).toContainText('Reassign the review of PLN-02');
    await dialog(page).getByLabel(/^Assigned to/).selectOption('');
    await expect(dialog(page).locator('[data-rule="BR-17"]')).toContainText('A document in review needs a person who acts on it.');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('A document in review needs a person who acts on it.');
    await dialog(page).getByLabel(/^Assigned to/).selectOption('rina');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Review of PLN-02 assigned to Rina Kusuma');
  });

  for (const theme of ['light', 'dark']) {
    test(`every form and the Versions tab are readable, ${theme} theme`, async ({ page }) => {
      await openApp(page, `?theme=${theme}`);
      await go(page, 'Document register');
      await ui.pageAction(page, 'New document').click();
      await expect(ui.drawer(page)).toContainText('Start from a template');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await expect(ui.drawer(page)).toHaveCount(0);
      await openRow(page, 'PLN-02');
      await expectOverlayReadable(page);
      for (const name of ['Edit', 'Change owner or approver', 'Reassign']) {
        await panelButton(page, name).click();
        await expect(ui.modal(page)).toHaveCount(1);
        await expectOverlayReadable(page);
        await page.keyboard.press('Escape');
        await expect(ui.modal(page)).toHaveCount(0);
      }
      await drawerAction(page, 'Open review').click();
      await expect(dialog(page)).toContainText('No new file in this review.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await panel(page).locator('[role="tab"]', { hasText: 'Versions' }).click();
      await expect(panel(page).locator('[data-version]')).toHaveCount(1);
      await expectOverlayReadable(page);
    });
  }
});
