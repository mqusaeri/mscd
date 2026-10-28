import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
  list, listRows, listRow, search,
} from '../helpers.js';

// Registers of the sample build (MILESTONE-2 M2-13): the seven registers of the sample ISMS with their drawers, "Add
// record" and "Edit" (BR-17, BR-22), risk treatments along C.13 with BR-04 and the residual acceptance by the risk
// owner, metric values, competence records with a proof file from the repository picker, links to other systems, and
// what other personas see (H.5). @sample-only: the API project covers the screen in e2e/api-only/registers.spec.js.
const meta = metaById('registers');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: new RegExp(`^${name}$`) });
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const field = (scope, label) => scope.getByLabel(new RegExp(`^${label}`));

async function openRegister(page, name, query = '') {
  await openScreen(page, meta, query);
  await tab(page, name).click();
  await expect(list(page)).toBeVisible();
}

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Registers @sample-only', () => {
  test('lists every register of the ISMS, searches, and opens a drawer per row', async ({ page }) => {
    await openScreen(page, meta);
    await expect(page.locator('main h1')).toHaveText('Registers');
    await expect(tab(page, 'Context issues')).toHaveAttribute('aria-selected', 'true');
    await expect(listRows(page)).toHaveCount(5);
    await expect(list(page)).toContainText('Showing 5 of 5 items');
    for (const [name, code] of [['Interested parties', 'IP-01'], ['Assets', 'AS-02'], ['Risks', 'R-014'], ['Metrics', 'M-07'], ['Objectives', 'QO-11'], ['Competence', 'Maya Putri']]) {
      await tab(page, name).click();
      await expect(listRow(page, code)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoTextOverflow(page);
    }
    await tab(page, 'Risks').click();
    await search(page, 'bagus');
    await expect(listRows(page)).toHaveCount(1);
    await expect(listRows(page).first()).toContainText('R-014');
    await search(page, 'nothing like this');
    await expect(list(page)).toContainText('No record matches the search');
    await search(page, '');
    await listRow(page, 'R-014').click();
    await expect(drawer(page)).toContainText('R-014  Privileged credential misuse');
    await expect(drawer(page)).toContainText('Information security risk');
    await expect(drawer(page).locator('[data-treatment="T-014"]')).toContainText('In progress');
    await expect(drawer(page)).toContainText('Linked systems');
    await expectOverlayReadable(page);
    await expectReadableText(page, 4.5);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('Add record adds a risk with its owner (BR-17), and Edit asks before changing a shared asset (BR-22)', async ({ page }) => {
    await openRegister(page, 'Risks');
    await ui.pageAction(page, 'Add record').click();
    await expect(drawer(page)).toContainText('Add to Risks');
    await expectOverlayReadable(page);
    await expect(field(drawer(page), 'ID')).toHaveValue('R-036');
    await field(drawer(page), 'Title').fill('Loss of the backup site');
    await expect(drawer(page)).toContainText('Every risk needs an owner (BR-17).');
    await button(drawer(page), 'Save').click();
    await expect(drawer(page).locator('.mx-field').filter({ hasText: /^Owner/ }).locator('.mx-error')).toHaveText('Required');
    await drawer(page).locator('select[name="ownerHandle"]').selectOption('bagus');
    await drawer(page).locator('select[name="likelihood"]').selectOption('2');
    await drawer(page).locator('select[name="consequence"]').selectOption('5');
    await drawer(page).locator('select[name="treatmentOption"]').selectOption('modify');
    await button(drawer(page), 'Save').click();
    await expectToast(page, 'R-036 added');
    await expect(listRow(page, 'R-036')).toContainText('Loss of the backup site');
    await expect(listRow(page, 'R-036')).toContainText('10');

    await tab(page, 'Assets').click();
    await listRow(page, 'AS-02').click();
    await expect(drawer(page)).toContainText('Shared with 2 systems');
    await button(drawer(page), 'Edit').click();
    await expect(drawer(page)).toContainText('This record is shared with ISMS, BCMS. A change applies in every linked system.');
    await drawer(page).locator('select[name="classification"]').selectOption('restricted');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Save').click();
    await expect(dialog(page)).toContainText('AS-02 is shared with ISMS, BCMS. The change applies to every linked system.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Confirm').click();
    await expectToast(page, 'AS-02 saved');
    await expect(drawer(page)).toContainText('Restricted');
  });

  test('a treatment moves along C.13; closing waits for the residual acceptance (BR-04), which the implementer cannot give', async ({ page }) => {
    await openRegister(page, 'Risks');
    await listRow(page, 'R-031').click();
    await button(drawer(page), 'Add treatment').click();
    await expect(dialog(page)).toContainText('Add a treatment to R-031');
    await expect(field(dialog(page), 'Treatment ID')).toHaveValue('T-032');
    await field(dialog(page), 'What will be done').fill('Patch the hypervisors in Surabaya');
    await dialog(page).locator('select[name="treatmentOwner"]').selectOption('bagus');
    await field(dialog(page), 'Due date').fill('2026-12-15');
    await dialog(page).locator('input[type="search"]').fill('A.8.8');
    await dialog(page).locator('[role="option"]').first().click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Add treatment').click();
    await expectToast(page, 'T-032 added to R-031');
    const t032 = drawer(page).locator('[data-treatment="T-032"]');
    await expect(t032).toContainText('Proposed');
    await button(t032, 'Approve').click();
    await expect(t032).toContainText('Approved');
    await button(t032, 'Start').click();
    await expect(t032).toContainText('In progress');
    await button(t032, 'Mark implemented').click();
    await expect(t032).toContainText('Implemented');
    await expect(t032).toContainText('Implemented by Rina Kusuma');
    await expect(button(t032, 'Close treatment')).toBeDisabled();
    await expect(t032).toContainText('Accept the residual risk first (BR-04).');
    // rina owns R-031 but implemented T-032 herself.
    await expect(button(drawer(page), 'Accept residual risk')).toBeDisabled();
    await expect(drawer(page)).toContainText('You implemented this treatment, so the risk owner has to accept the residual risk (BR-04).');
    await expectOverlayReadable(page);
  });

  test('the risk owner accepts the residual risk of a treatment someone else implemented, then the treatment closes', async ({ page }) => {
    await openRegister(page, 'Risks');
    await listRow(page, 'R-003').click();
    const t003 = drawer(page).locator('[data-treatment="T-003"]');
    await expect(t003).toContainText('Implemented by Bagus Prasetyo');
    await button(drawer(page), 'Accept residual risk').click();
    await expect(dialog(page)).toContainText('Accept the residual risk of R-003');
    await dialog(page).locator('select[name="residualLikelihood"]').selectOption('1');
    await dialog(page).locator('select[name="residualConsequence"]').selectOption('2');
    await button(dialog(page), 'Accept residual risk').click();
    await expect(dialog(page)).toContainText('Required');
    await dialog(page).locator('textarea[name="residualNote"]').fill('Quarterly access reviews run since March');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Accept residual risk').click();
    await expectToast(page, 'Residual risk of R-003 accepted');
    await expect(t003).toContainText('Residual risk accepted');
    await expect(drawer(page)).toContainText('2 (likelihood 1, impact 2)');
    await button(t003, 'Close treatment').click();
    await expect(t003).toContainText('Closed');
    // R-022 belongs to Hendra Wijaya: only he accepts it.
    await page.keyboard.press('Escape');
    await listRow(page, 'R-022').click();
    await expect(button(drawer(page), 'Accept residual risk')).toBeDisabled();
    await expect(drawer(page)).toContainText('Only the risk owner, Hendra Wijaya, can accept the residual risk.');
  });

  test('Record value of a metric refuses an overlapping period and marks the metric measured', async ({ page }) => {
    await openRegister(page, 'Metrics');
    await listRow(page, 'M-07').click();
    await expect(drawer(page)).toContainText('Action open');
    await button(drawer(page), 'Record value').click();
    await expect(dialog(page)).toContainText('Record a value for M-07');
    await field(dialog(page), 'Period from').fill('2026-09-01');
    await field(dialog(page), 'Period to').fill('2026-09-28');
    await field(dialog(page), 'Value').fill('96.5');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Record value').click();
    await expectToast(page, 'Value recorded for M-07');
    await expect(drawer(page)).toContainText('Ready');
    await button(drawer(page), 'Record value').click();
    await field(dialog(page), 'Period from').fill('2026-09-15');
    await field(dialog(page), 'Period to').fill('2026-09-30');
    await field(dialog(page), 'Value').fill('97');
    await button(dialog(page), 'Record value').click();
    await expect(dialog(page)).toContainText('The period overlaps the value recorded for 2026-09-01 to 2026-09-28');
  });

  test('a competence record keeps its proof file from the repository picker, and an objective links its metric', async ({ page }) => {
    await openRegister(page, 'Competence');
    await expect(listRow(page, 'Bagus Prasetyo')).toContainText('Renew within 30 days');
    await button(list(page), 'Add').click();
    await expect(drawer(page)).toContainText('Add to Competence');
    await drawer(page).locator('select[name="ownerHandle"]').selectOption('rina');
    await drawer(page).locator('.mx-field').filter({ hasText: /^Person/ }).locator('select').selectOption('fajar');
    await field(drawer(page), 'Role').fill('Facilities manager');
    await field(drawer(page), 'Competence required').fill('Physical security of the data centre');
    await drawer(page).locator('select[name="proofType"]').selectOption('training');
    await field(drawer(page), 'Valid until').fill('2027-06-30');
    // Only the evidence record of competence is offered (A.6.3 in the sample ISMS); its current file is replaced.
    const holders = drawer(page).locator('select[name="proofEvidence"] option');
    await expect(holders).toHaveCount(2);
    await expect(holders.nth(1)).toHaveText(/^EV-0217/);
    await drawer(page).locator('select[name="proofEvidence"]').selectOption({ index: 1 });
    await expect(drawer(page)).toContainText('EV-0217 already has a file. Saving puts the chosen file in its place, and EV-0217 shows it as produced today.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Choose file').click();
    const picker = dialog(page);
    await expect(picker).toBeVisible();
    await page.locator('div[style*="z-index: 51"] button', { hasText: /^(Link selected file|Upload)/ }).first().click();
    await expect(drawer(page)).toContainText('Chosen:');
    await button(drawer(page), 'Save').click();
    await expectToast(page, /CMP-[0-9A-F]{8} added/);
    await listRow(page, 'Fajar Nugroho').click();
    await expect(drawer(page)).toContainText('Physical security of the data centre');
    await expect(drawer(page)).not.toContainText('No proof file yet');
    await page.keyboard.press('Escape');

    await tab(page, 'Objectives').click();
    await listRow(page, 'QO-11').click();
    await button(drawer(page), 'Edit').click();
    await expect(drawer(page).locator('select[name="metricCode"]')).toHaveValue('M-07');
    await drawer(page).locator('select[name="objectiveStatus"]').selectOption('achieved');
    await field(drawer(page), 'Result').fill('96.2% of critical patches within 14 days');
    await field(drawer(page), 'Achieved on').fill('2026-09-28');
    await button(drawer(page), 'Save').click();
    await expectToast(page, 'QO-11 saved');
    await expect(drawer(page)).toContainText('Achieved');
    await expect(drawer(page)).toContainText('96.2% of critical patches within 14 days');
  });

  test('links an asset to another system, makes it primary there, and removes a link', async ({ page }) => {
    await openRegister(page, 'Assets');
    await listRow(page, 'AS-01').click();
    await button(drawer(page), 'Link to another system').click();
    await expect(dialog(page)).toContainText('Link AS-01 to another system');
    await dialog(page).locator('select[name="linkSystem"]').selectOption('bcms');
    await field(dialog(page), 'Why it matters there').fill('The database cluster runs the continuity services too');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Link to another system').click();
    await expectToast(page, 'AS-01 linked to BCMS');
    const links = drawer(page).locator('.mx-reg-links li');
    await expect(links).toHaveCount(2);
    await button(links.nth(1), 'Make primary').click();
    await expect(dialog(page)).toContainText('Make BCMS the primary system');
    await button(dialog(page), 'Make primary').click();
    await expectToast(page, 'BCMS is now the primary system of AS-01');
    await expect(links.nth(0)).toContainText('BCMS');
    await expect(links.nth(0)).toContainText('Primary');
    await button(drawer(page), 'Link to another system').click();
    await dialog(page).locator('select[name="linkSystem"]').selectOption('qms');
    await button(dialog(page), 'Link to another system').click();
    await expectToast(page, 'AS-01 linked to QMS');
    await button(links.filter({ hasText: 'QMS' }), 'Remove link').click();
    await expect(dialog(page)).toContainText('AS-01 will no longer show in QMS.');
    await button(dialog(page), 'Remove link').click();
    await expectToast(page, 'AS-01 is no longer linked to QMS');
    await expect(links).toHaveCount(2);
  });

  test('the Domain Owner persona sees own rows only and reads; Top Management sees no owner of other rows', async ({ page }) => {
    await page.goto('/?screen=registers&persona=owner');
    await expect(page.locator('main h1')).toHaveText('Registers');
    await expect(ui.pageAction(page, 'Add record')).toHaveCount(0);
    await tab(page, 'Risks').click();
    await expect(listRows(page)).toHaveCount(1);
    await expect(listRows(page).first()).toContainText('R-014');
    await expect(page.locator('main')).toContainText('You can read this register.');
    await tab(page, 'Competence').click();
    await expect(listRows(page)).toHaveCount(1);
    await expect(listRows(page).first()).toContainText('Bagus Prasetyo');
    await page.goto('/?screen=registers&persona=top');
    await tab(page, 'Risks').click();
    await expect(listRow(page, 'R-022')).toContainText('Hendra Wijaya');
    await expect(listRow(page, 'R-014')).toContainText('Unassigned');
    await listRow(page, 'R-022').click();
    await expect(drawer(page)).not.toContainText('Add treatment');
    await expect(button(drawer(page), 'Edit')).toHaveCount(0);
  });

  test('Indonesian labels, forms and the drawer in the dark theme', async ({ page }) => {
    await openScreen(page, meta, 'lang=id&theme=dark');
    await expect(page.locator('main h1')).toHaveText('Register');
    await expect(list(page)).toContainText(/Menampilkan \d+ item dari \d+/);
    await page.locator('main [role="tab"]', { hasText: /^Risiko$/ }).click();
    await listRow(page, 'R-014').click();
    await expect(drawer(page)).toContainText('Perlakuan');
    await expect(drawer(page)).toContainText('Sistem tertaut');
    await expectOverlayReadable(page);
    await button(drawer(page), 'Ubah').click();
    await expect(drawer(page)).toContainText('Ubah R-014');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toContainText('R-014  Privileged credential misuse');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await ui.pageAction(page, 'Tambah catatan').click();
    await expect(drawer(page)).toContainText('Tambah ke Risiko');
    await expectOverlayReadable(page);
    await expectReadableText(page, 4.5);
  });
});
