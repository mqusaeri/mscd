import { randomUUID } from 'node:crypto';
import {
  test, expect, ui, go, openApp, switchMs, chip, chipCount, search, openRow, listRow, listRows, groupRows, drawerFact, expectToast,
  expectOverlayReadable,
} from '../helpers.js';

// The controls and requirements forms against the api (MILESTONE-2 M2-11). A new ISO/IEC 27001 system has its clause
// entries from the pack (D2-09): the Controls screen shows the group "Clauses 4 to 10" first with "Cl. 4.1", and the
// clause entry cl-5.1 and the control 5.1 open different records (the end-to-end check of the M2-01 clause group).
// rina, MS Manager of the demo ISMS, adds a clause row with "Add control" (`applicability.targets`, `applicability.create`),
// edits a control (`applicability.update`, `operating-criteria`), marks one not applicable with the BR-03 warning, finds
// "Mark not applicable" refused on a clause row (APPL-ASSESS), deletes an entry (`records.delete`) and rejects an entry
// that waits for verification. maya (Internal Auditor) gets no form.
const panel = (page) => ui.drawer(page).locator('[data-m11="entry"]');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

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

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Controls and requirements forms against the api @api-only', () => {
  test.describe('a new ISO/IEC 27001 system', () => {
    test.use({ apiSession: null });

    test('groups Clauses 4 to 10 first, and the clause entry cl-5.1 and the control 5.1 open different records', async ({ page, baseURL }) => {
      test.slow();
      await signIn(page, baseURL, 'tenant.admin', 'tst');
      await apiWrite(page, baseURL, 'POST', '/api/v1/admin/management-systems', {
        slug: 'isms2', code: 'ISMS2', name: 'Information security, Surabaya site', packId: 'ISO27001-2022', edition: '2022',
        scopeStatement: 'Managed services operations at the Surabaya data centre', defaultRepository: 'vault', color: '#2e7fb8',
      });
      const systems = await (await page.request.get(`${baseURL}/api/v1/admin/management-systems`)).json();
      const id = systems.find((s) => s.slug === 'isms2').id;
      await apiWrite(page, baseURL, 'POST', `/api/v1/admin/management-systems/${id}/roles`, { user: 'bagus', role: 'ms_manager', isPrimary: true });
      await apiWrite(page, baseURL, 'PATCH', `/api/v1/admin/management-systems/${id}`, { status: 'implementing' });

      await signIn(page, baseURL, 'bagus', 'tst');
      await openApp(page);
      await switchMs(page, 'ISMS2');
      await go(page, 'Controls & requirements');
      await expect.poll(() => chipCount(page, 'All'), { timeout: 15_000 }).toBe(123);
      await chip(page, 'All').click();
      await expect(groupRows(page).first()).toContainText('Clauses 4 to 10');
      await expect(listRows(page).first()).toContainText('Cl. 4.1');

      await search(page, 'Cl. 5.1');
      await openRow(page, 'Cl. 5.1');
      await expect(ui.drawer(page)).toContainText('Leadership and commitment');
      await expect(ui.drawer(page)).not.toContainText('Policies for information security');
      // A clause row always applies (D2-09): the target data marks it, and the form refuses to exclude it.
      await expect(panel(page)).toContainText('Always applicable');
      await expect(button(panel(page), 'Mark not applicable')).toBeDisabled();
      await expect(panel(page)).toContainText('A clause requirement always applies and cannot be marked not applicable.');
      await expectOverlayReadable(page);

      await search(page, 'A.5.1');
      await openRow(page, 'Policies for information security');
      await expect(ui.drawer(page)).toContainText('A.5.1');
      await expect(ui.drawer(page)).not.toContainText('Leadership and commitment');
      await expect(panel(page)).not.toContainText('Always applicable');
      await expect(button(panel(page), 'Mark not applicable')).toBeEnabled();
    });
  });

  test('Add control lists the clause rows without an entry and adds one to the Statement of Applicability', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    const all = await chipCount(page, 'All');
    await ui.pageAction(page, 'Add control').click();
    await expect(dialog(page)).toContainText('Add control or requirement');
    const options = dialog(page).locator('[role="option"]');
    await expect(options.first()).toBeVisible();
    // The demo ISMS holds every Annex A control and no clause row; the retired 10.3 is not offered.
    await expect(options.first()).toContainText('Cl. 4.1');
    await dialog(page).locator('input[type="search"]').fill('10.3');
    await expect(options).toHaveCount(0);
    await dialog(page).locator('input[type="search"]').fill('context');
    await options.filter({ hasText: 'Cl. 4.1' }).click();
    await expect(dialog(page)).toContainText('Chosen: Cl. 4.1, Understanding the organization and its context');
    await expect(dialog(page).locator('input[type="radio"]').first()).toBeDisabled();
    await dialog(page).locator('textarea[name="inclusionJustification"]').fill('The context of the organisation is a clause of the standard.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Add entry').click();
    // A new applicable entry may hold the gate until a risk is linked (BR-02 warning); the form then shows it.
    // The text is read without waiting (M2-21): `innerText()` waits up to the action timeout for a dialog that closed
    // between the two reads, longer than the poll. No dialog left, or every one shows the message.
    await expect.poll(async () => (await dialog(page).allInnerTexts()).every((text) => text.includes('Cl. 4.1 added'))).toBe(true);
    if (await dialog(page).count()) await button(dialog(page), 'Close').click();
    await expect.poll(() => chipCount(page, 'All')).toBe(all + 1);
    await chip(page, 'All').click();
    await expect(groupRows(page).first()).toContainText('Clauses 4 to 10');
    await expect(listRows(page).first()).toContainText('Cl. 4.1');
  });

  test('Edit entry saves the owner, justification and frequency, and Mark not applicable warns on an empty justification', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.1');
    await button(panel(page), 'Edit entry').click();
    await expect(dialog(page)).toContainText('Edit A.5.1');
    // The register lists every implementing document of the entry.
    await expect(dialog(page).locator('.mx-m11-codes').nth(1)).toContainText('POL-01');
    await dialog(page).locator('select').first().selectOption('bagus');
    await dialog(page).locator('textarea[name="inclusionJustification"]').fill('Required by the treatment of R-003 and R-014.');
    await dialog(page).locator('select[name="frequencyCode"]').selectOption('quarterly');
    await dialog(page).locator('textarea[name="description"]').fill('Policies are reviewed every quarter by the ISMS committee.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'A.5.1 saved');
    await expect(drawerFact(page, 'Owner')).toContainText('Bagus Prasetyo');
    await expect(drawerFact(page, 'Operating frequency')).toHaveText('Quarterly');
    await expect(drawerFact(page, 'Justification')).toHaveText('Required by the treatment of R-003 and R-014.');

    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.2');
    await button(panel(page), 'Mark not applicable').click();
    await dialog(page).locator('textarea').fill('n/a');
    await button(dialog(page), 'Mark not applicable').click();
    await expect(dialog(page)).toContainText('Saved. Check the warnings below.');
    await expect(dialog(page).locator('.mx-m11-warn')).toContainText('The exclusion justification does not look meaningful.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Close').click();
    await chip(page, 'Not applicable').click();
    await expect(listRow(page, 'A.5.2')).toContainText('Not applicable');
  });

  test('Delete entry removes an entry with a reason, and Reject returns a completed entry to Partial', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    const all = await chipCount(page, 'All');
    await openRow(page, 'A.5.3');
    await button(panel(page), 'Delete entry').click();
    await dialog(page).locator('textarea').fill('Merged into the access control entry A.5.15');
    await button(dialog(page), 'Delete entry').click();
    await expectToast(page, 'A.5.3 deleted');
    await expect.poll(() => chipCount(page, 'All')).toBe(all - 1);

    // rina, MS Manager of QMS, rejects Cl. 8.7, which the seed holds complete and awaiting verification (C.13: the
    // rejection needs applicability.verify and no other rule).
    await switchMs(page, 'QMS');
    await go(page, 'Controls & requirements');
    await chip(page, 'All').click();
    await search(page, 'Cl. 8.7');
    await openRow(page, 'Cl. 8.7');
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    await button(panel(page), 'Reject').click();
    await expect(dialog(page)).toContainText('The entry goes back to Partially implemented.');
    await dialog(page).locator('textarea').fill('The calibration log misses September.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Reject').click();
    await expectToast(page, 'Cl. 8.7 returned to Partially implemented');
    await expect(listRow(page, 'Cl. 8.7')).toContainText('Partial');
    await expect(listRow(page, 'Cl. 8.7')).not.toContainText('awaiting verification');
  });

  test.describe('as the Internal Auditor', () => {
    test.use({ apiSession: 'maya' });
    test('gets no entry form on a control', async ({ page }) => {
      await openApp(page);
      await go(page, 'Controls & requirements');
      await openRow(page, 'A.5.1');
      await expect(button(ui.drawer(page), 'Edit entry')).toHaveCount(0);
      await expect(button(ui.drawer(page), 'Delete entry')).toHaveCount(0);
      await expect(button(ui.drawer(page), 'Define evidence')).toHaveCount(0);
    });
  });
});
