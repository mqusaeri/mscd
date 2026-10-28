import { test, expect, ui, go, openApp, list, listRow, listRows, search, expectToast, expectOverlayReadable } from '../helpers.js';

// Registers against the api (MILESTONE-2 M2-13). In the demo ISMS rina is the MS Manager, bagus a Domain Owner who
// owns risks, maya the Internal Auditor and hendra Top Management. rina adds a risk owned by bagus
// (`registers.create`, BR-17) and a treatment (`treatments.create`), moves it along C.13 (`treatments.transition`), and
// cannot accept the residual risk of a risk she does not own; bagus accepts it (`risks.residual-acceptance`, BR-04: he
// did not implement the treatment), and rina closes the treatment. rina records a metric value
// (`metrics.values.create`), links a context issue to the QMS (`entity-links.create`), changes it after the BR-22
// confirmation and makes the QMS its primary system (`registers.update` with `linkedMs`), adds a competence record
// whose proof file comes from the SharePoint picker through the evidence record of competence (`evidence.files`, A.6.3
// in the demo ISMS; no other evidence record is offered, and the file is attached only after the record is created),
// and the competence record shows to the people H.5 names only.
// A treatment refused for a used code after the risk's option changed goes through on the next try (no stale ETag).
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: new RegExp(`^${name}$`) });
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const field = (scope, label) => scope.getByLabel(new RegExp(`^${label}`));

async function signIn(page, baseURL, handle, org = 'ndt') {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openRegisters(page, name) {
  await openApp(page);
  await go(page, 'Registers');
  await tab(page, name).click();
  await expect(list(page)).toBeVisible();
  // The read of the register has answered: no loading line, and the footer counts the rows.
  await expect(list(page).locator('[role="status"]')).toHaveCount(0);
  await expect(list(page)).toContainText(/Showing \d+ of \d+ items/);
}

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Registers against the api @api-only', () => {
  test.use({ apiSession: null });

  test('a risk gets a treatment that moves along C.13; its owner accepts the residual risk and the treatment closes', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina');
    await openRegisters(page, 'Risks');
    await listRow(page, 'R-014').click();
    await expect(drawer(page)).toContainText('R-014  Privileged credential misuse');
    await expect(drawer(page).locator('[data-treatment="T-014"]')).toContainText('In progress');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');

    await ui.pageAction(page, 'Add record').click();
    await expect(drawer(page)).toContainText('Add to Risks');
    const code = await field(drawer(page), 'ID').inputValue();
    expect(code).toMatch(/^R-\d+$/);
    await field(drawer(page), 'Title').fill('Loss of the backup site');
    await drawer(page).locator('select[name="ownerHandle"]').selectOption('bagus');
    await drawer(page).locator('select[name="likelihood"]').selectOption('2');
    await drawer(page).locator('select[name="consequence"]').selectOption('5');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Save').click();
    await expectToast(page, `${code} added`);
    await search(page, code);
    await expect(listRow(page, code)).toContainText('Loss of the backup site');
    await expect(listRow(page, code)).toContainText('Action open');

    await listRow(page, code).click();
    await expect(drawer(page)).toContainText('No treatment yet.');
    await button(drawer(page), 'Add treatment').click();
    await expect(dialog(page)).toContainText(`Add a treatment to ${code}`);
    // The controls show once the treatment codes of the system are read: the suggested code is free in the system.
    await expect(dialog(page).locator('input[type="search"]')).toBeVisible();
    const treatment = await field(dialog(page), 'Treatment ID').inputValue();
    expect(treatment).toMatch(/^T-\d+$/);
    expect(treatment).not.toBe('T-014');
    await field(dialog(page), 'What will be done').fill('Second backup site in Surabaya');
    await dialog(page).locator('select[name="treatmentOwner"]').selectOption('bagus');
    await field(dialog(page), 'Due date').fill('2026-12-15');
    await dialog(page).locator('input[type="search"]').fill('A.8.13');
    await dialog(page).locator('[role="option"]').first().click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    // T-014 is a treatment of R-014. The new risk has no treatment option, so the first try sets it to Modify and the
    // create is refused; the next try sends the create only, and the changed risk carries no stale ETag.
    await field(dialog(page), 'Treatment ID').fill('T-014');
    await button(dialog(page), 'Add treatment').click();
    await expect(dialog(page)).toContainText('This ID is already used.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await field(dialog(page), 'Treatment ID').fill(treatment);
    await button(dialog(page), 'Add treatment').click();
    await expectToast(page, `${treatment} added to ${code}`);
    await expect(dialog(page)).toHaveCount(0);
    const row = drawer(page).locator(`[data-treatment="${treatment}"]`);
    await expect(row).toContainText('Proposed');
    await expect(row).toContainText('A.8.13');
    await button(row, 'Approve').click();
    await expect(row).toContainText('Approved');
    await button(row, 'Start').click();
    await expect(row).toContainText('In progress');
    await button(row, 'Mark implemented').click();
    await expect(row).toContainText('Implemented');
    await expect(row).toContainText('Implemented by Rina Kusuma');
    await expect(button(row, 'Close treatment')).toBeDisabled();
    await expect(button(drawer(page), 'Accept residual risk')).toBeDisabled();
    await expect(drawer(page)).toContainText('Only the risk owner, Bagus Prasetyo, can accept the residual risk.');

    await signIn(page, baseURL, 'bagus');
    await openRegisters(page, 'Risks');
    await listRow(page, code).click();
    await expect(drawer(page).locator(`[data-treatment="${treatment}"]`)).toContainText('No open action');
    await button(drawer(page), 'Accept residual risk').click();
    await expect(dialog(page)).toContainText(`Accept the residual risk of ${code}`);
    await dialog(page).locator('select[name="residualLikelihood"]').selectOption('1');
    await dialog(page).locator('select[name="residualConsequence"]').selectOption('3');
    await dialog(page).locator('textarea[name="residualNote"]').fill('The second site takes over within four hours');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Accept residual risk').click();
    await expectToast(page, `Residual risk of ${code} accepted`);
    await expect(drawer(page)).toContainText('Residual risk accepted on');
    await expect(drawer(page)).toContainText('3 (likelihood 1, impact 3)');

    await signIn(page, baseURL, 'rina');
    await openRegisters(page, 'Risks');
    await search(page, code);
    await listRow(page, code).click();
    const done = drawer(page).locator(`[data-treatment="${treatment}"]`);
    await button(done, 'Close treatment').click();
    await expect(done).toContainText('Closed');
  });

  test('a metric value is recorded once per period, and a linked context issue changes after the BR-22 confirmation', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina');
    await openRegisters(page, 'Metrics');
    await listRow(page, 'M-07').click();
    await expect(drawer(page)).toContainText('Action open');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Record value').click();
    await field(dialog(page), 'Period from').fill('2026-08-01');
    await field(dialog(page), 'Period to').fill('2026-08-31');
    await field(dialog(page), 'Value').fill('96.5');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record value').click();
    await expectToast(page, 'Value recorded for M-07');
    await expect(drawer(page)).toContainText('Ready');
    await button(drawer(page), 'Record value').click();
    await field(dialog(page), 'Period from').fill('2026-08-15');
    await field(dialog(page), 'Period to').fill('2026-09-15');
    await field(dialog(page), 'Value').fill('97');
    await button(dialog(page), 'Record value').click();
    await expect(dialog(page)).toContainText('The period overlaps the value recorded for 2026-08-01 to 2026-08-31');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);

    await tab(page, 'Context issues').click();
    await listRow(page, 'CI-09').click();
    await button(drawer(page), 'Link to another system').click();
    await dialog(page).locator('select[name="linkSystem"]').selectOption('qms');
    await field(dialog(page), 'Why it matters there').fill('The regulation also changes customer contracts');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Link to another system').click();
    await expectToast(page, 'CI-09 linked to QMS');
    await expect(drawer(page)).toContainText('Shared with 2 systems');
    await button(drawer(page), 'Edit').click();
    await expect(drawer(page)).toContainText('Edit CI-09');
    await field(drawer(page), 'Description').fill('Implementing regulation of the PDP Law, effective next year');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Save').click();
    await expect(dialog(page)).toContainText('Change a shared record');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Confirm').click();
    await expectToast(page, 'CI-09 saved');
    await expect(drawer(page)).toContainText('Implementing regulation of the PDP Law, effective next year');
    const links = drawer(page).locator('.mx-reg-links li');
    await button(links.filter({ hasText: 'QMS' }), 'Remove link').click();
    await expect(dialog(page)).toContainText('Remove the link to QMS');
    await expect(dialog(page)).toContainText('CI-09 will no longer show in QMS.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Cancel').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(drawer(page)).toContainText('Shared with 2 systems');
    await button(links.filter({ hasText: 'QMS' }), 'Make primary').click();
    await expect(dialog(page)).toContainText('Make QMS the primary system');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Make primary').click();
    await expectToast(page, 'QMS is now the primary system of CI-09');
    await expect(links.nth(0)).toContainText('QMS');
    await expect(links.nth(0)).toContainText('Primary');
  });

  test('a competence record keeps its proof from the picker, and only the people H.5 names see it', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina');
    await openRegisters(page, 'Competence');
    await button(list(page), 'Add').click();
    await expect(drawer(page)).toContainText('Add to Competence');
    await drawer(page).locator('.mx-field').filter({ hasText: /^Person/ }).locator('select').selectOption('bagus');
    await field(drawer(page), 'Role').fill('IT infrastructure lead');
    await field(drawer(page), 'Competence required').fill('Administration of privileged access management');
    await drawer(page).locator('select[name="proofType"]').selectOption('training');
    await field(drawer(page), 'Achieved on').fill('2025-06-10');
    await field(drawer(page), 'Valid until').fill('2027-06-10');
    await drawer(page).locator('select[name="ownerHandle"]').selectOption('rina');
    // Only an evidence record of competence keeps the proof: A.6.3 awareness training, never the backup log of A.8.13.
    const holder = drawer(page).locator('select[name="proofEvidence"]');
    await expect(holder.locator('option', { hasText: 'EV-0313' })).toHaveCount(0);
    const value = await holder.locator('option', { hasText: 'EV-0217' }).getAttribute('value');
    await holder.selectOption(value);
    await expect(drawer(page)).toContainText('EV-0217 already has a file. Saving puts the chosen file in its place, and EV-0217 shows it as produced today.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Choose file').click();
    const picker = dialog(page);
    await expect(picker).toContainText('Compliance / ISMS / Evidence');
    const files = picker.locator('button[style*="grid-template-columns: 1fr auto"]');
    await expect(files.first()).toBeVisible();
    const name = (await files.first().innerText()).split('\n')[0].trim();
    await button(picker, 'Link selected file').click();
    await expect(drawer(page)).toContainText(`Chosen: ${name}`);
    // The evidence record gets the file only after the server accepted the new competence record: the create, then
    // the attach, then the patch that points the record to the stored file.
    const writes = [];
    const onWrite = (req) => {
      const path = new URL(req.url()).pathname;
      if (req.method() !== 'GET' && /\/registers\/competence(\/|$)|\/evidence\/[^/]+\/files$/.test(path)) writes.push(`${req.method()} ${path.replace(/\/[0-9a-f-]{36}/g, '/:id')}`);
    };
    page.on('request', onWrite);
    await button(drawer(page), 'Save').click();
    await expectToast(page, /CMP-[0-9A-F]{8} added/);
    page.off('request', onWrite);
    expect(writes).toEqual(['POST /api/v1/ms/isms/registers/competence', 'POST /api/v1/ms/isms/evidence/:id/files', 'PATCH /api/v1/ms/isms/registers/competence/:id']);
    await listRow(page, 'Bagus Prasetyo').click();
    await expect(drawer(page)).toContainText('Administration of privileged access management');
    await expect(drawer(page)).toContainText('A proof file is stored');
    await expect(button(drawer(page), 'Open proof file')).toBeVisible();
    await inBothThemes(page, () => expectOverlayReadable(page));

    await signIn(page, baseURL, 'hendra');
    await openRegisters(page, 'Competence');
    await expect(listRows(page)).toHaveCount(0);
    await expect(list(page)).toContainText('Showing 0 of 0 items');
    await expect(ui.pageAction(page, 'Add record')).toHaveCount(0);

    await signIn(page, baseURL, 'maya');
    await openRegisters(page, 'Competence');
    await expect(listRow(page, 'Bagus Prasetyo')).toContainText('IT infrastructure lead');

    await signIn(page, baseURL, 'bagus');
    await openRegisters(page, 'Competence');
    await expect(listRow(page, 'Bagus Prasetyo')).toContainText('IT infrastructure lead');
  });
});
