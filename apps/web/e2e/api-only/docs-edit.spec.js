import { randomUUID } from 'node:crypto';
import {
  test, expect, ui, go, openApp, openRow, listRow, switchMs, expectToast, expectOverlayReadable, drawerAction,
} from '../helpers.js';

// The document control forms against the api (MILESTONE-2 M2-12, D.1, D.2). In the anti-bribery system of the demo
// organisation (Managed Vault) rina registers the scope statement SCO-A01 from its template with bagus as owner; bagus
// attaches the first version as a vault upload with a change summary and cannot approve it, because he submitted it
// (BR-16); rina approves it. The phase board activity 2.3 that expects SCO-A01 is refused before (BR-40) and can be
// completed after. Edit of a shared document asks for the BR-22 confirmation, Reassign of a document in review asks
// for a person (BR-17), and every form is readable in both themes.
const panel = (page) => ui.drawer(page).locator('[data-docs-edit]');
const panelButton = (page, name) => panel(page).locator('button', { hasText: new RegExp(`^${name}$`) });
const dialog = (page) => ui.modal(page).last();
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const scope = (page) => page.locator('main [data-scope]');

async function signIn(page, baseURL, handle) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A write of the api as the session's user, with its CSRF token; the answer's status and body. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, {
    method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Completes a phase board activity (`activity.transition` to complete) and answers the api's status and body. */
async function completeActivity(page, baseURL, ms, no) {
  const snap = await (await page.request.get(`${baseURL}/api/v1/ui/ms/${ms}`)).json();
  const ref = snap.refs[`${ms}:act:${no}`];
  expect(ref, `activity ${no} of ${ms}`).toBeTruthy();
  return apiWrite(page, baseURL, 'POST', `/api/v1/ms/${ms}/activities/${ref.id}/transitions`, { to: 'complete' });
}

test.describe('Document control forms against the api @api-only', () => {
  test.use({ apiSession: null });

  test('a document registered by rina gets its first version from bagus, who cannot approve it; rina approves it (BR-16, BR-40)', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina');
    const before = await completeActivity(page, baseURL, 'abms', '2.3');
    expect(before.status, JSON.stringify(before.body)).toBe(422);
    expect(before.body.rule).toBe('BR-40');

    await openApp(page);
    await switchMs(page, 'ABMS');
    await go(page, 'Required documented information');
    await expect(scope(page)).toContainText('No approved scope statement');
    await button(scope(page), 'Register from template').click();
    const form = ui.drawer(page);
    await expect(form).toContainText('Document register, ABMS');
    await expect(form.getByLabel(/^Document code/)).toHaveValue('SCO-A01');
    await expect(form.getByLabel(/^Title/)).toHaveValue('Scope of the ABMS');
    await expect(form.getByLabel(/^Document type/)).toHaveValue('policy');
    await form.getByLabel(/^Owner/).selectOption('bagus');
    await expectOverlayReadable(page);
    await button(form, 'Register document').click();
    await expectToast(page, 'SCO-A01 registered as a draft. Attach its first version from the document.');
    await expect(scope(page)).toContainText('SCO-A01 is registered and its state is draft.');

    await signIn(page, baseURL, 'bagus');
    await openApp(page);
    await switchMs(page, 'ABMS');
    await go(page, 'Document register');
    await openRow(page, 'SCO-A01');
    await expect(panel(page).locator('button')).toHaveText(['Actions', 'Versions', 'Attach first version']);
    await panelButton(page, 'Attach first version').click();
    const chooser = page.waitForEvent('filechooser');
    await ui.modal(page).locator('button', { hasText: 'Upload to Managed Vault' }).click();
    await (await chooser).setFiles({ name: 'ABMS-Scope-Statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% MSCD E2E scope statement\n%%EOF\n') });
    await expect(dialog(page)).toContainText('First version of SCO-A01');
    await expect(dialog(page)).toContainText('ABMS-Scope-Statement.pdf');
    await dialog(page).locator('textarea').fill('Scope covers procurement, sales and partner management at all sites');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Submit for review').click();
    await expectToast(page, 'SCO-A01 v1.0 submitted for review');
    await expect(ui.drawer(page)).toContainText('In review');
    await drawerAction(page, 'Open review').click();
    await expect(dialog(page)).toContainText('Review of SCO-A01');
    await expect(dialog(page)).toContainText('v1.0');
    await expect(dialog(page)).toContainText('Scope covers procurement, sales and partner management at all sites');
    await expect(button(dialog(page), 'Approve')).toBeDisabled();
    await expect(dialog(page)).toContainText('You submitted this version');
    await expectOverlayReadable(page);

    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await switchMs(page, 'ABMS');
    await go(page, 'Document register');
    await openRow(page, 'SCO-A01');
    await drawerAction(page, 'Open review').click();
    await expect(dialog(page)).toContainText('Bagus Prasetyo');
    await expect(button(dialog(page), 'Approve')).toBeEnabled();
    await button(dialog(page), 'Approve').click();
    await expectToast(page, 'SCO-A01 v1.0 approved');
    await expect(listRow(page, 'SCO-A01')).toContainText('Approved');
    await panel(page).locator('[role="tab"]', { hasText: 'Versions' }).click();
    const version = panel(page).locator('[data-version="1.0"]');
    await expect(version).toContainText('Approved by Rina Kusuma');
    await expect(version).toContainText('Submitted by Bagus Prasetyo');
    const opened = page.waitForResponse((r) => /\/api\/v1\/storage\/objects\/[^/]+\/open\?/.test(r.url()));
    const popup = page.waitForEvent('popup');
    await button(version, 'Open file').click();
    expect((await opened).status()).toBe(200);
    await (await popup).close();

    const after = await completeActivity(page, baseURL, 'abms', '2.3');
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect((after.body.warnings ?? []).map((w) => w.rule)).not.toContain('BR-47');
    await page.keyboard.press('Escape');
    await go(page, 'Required documented information');
    await expect(scope(page)).toHaveAttribute('data-scope', 'approved');
    await expect(scope(page)).toContainText('SCO-A01');
    await expect(scope(page)).toContainText('v1.0');
  });

  test('Edit of a shared document asks first; Reassign of a document in review asks for a person', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await go(page, 'Document register');
    await openRow(page, 'IMS-01');
    await panelButton(page, 'Edit').click();
    await dialog(page).getByLabel(/^Title/).fill('Document Control Procedure, 2026 edition');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('Change a shared document');
    await expect(dialog(page)).toContainText('This change also applies to:');
    await button(dialog(page), 'Apply to every system').click();
    await expectToast(page, 'IMS-01 saved');
    await expect(listRow(page, 'IMS-01')).toContainText('Document Control Procedure, 2026 edition');
    await page.keyboard.press('Escape');

    await openRow(page, 'PLN-02');
    await panelButton(page, 'Reassign').click();
    await expect(dialog(page)).toContainText('Reassign the review of PLN-02');
    await dialog(page).getByLabel(/^Assigned to/).selectOption('');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('A document in review needs a person who acts on it.');
    await dialog(page).getByLabel(/^Assigned to/).selectOption('rina');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Review of PLN-02 assigned to Rina Kusuma');
    await expect(ui.modal(page)).toHaveCount(0);
  });

  test('Top Management reads documents without the actions of document control', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'hendra');
    await openApp(page);
    await go(page, 'Required documented information');
    await expect(page.locator('main th', { hasText: 'Actions' })).toHaveCount(0);
    await expect(page.locator('main button', { hasText: 'Register from template' })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`New document, Edit, owner and approver, Reassign, the review panel and Versions are readable, ${theme} theme`, async ({ page, baseURL }) => {
      await signIn(page, baseURL, 'rina');
      await openApp(page, `?theme=${theme}`);
      await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', theme);
      await go(page, 'Document register');
      await ui.pageAction(page, 'New document').click();
      await expectToast(page, 'New document form opened');
      await expect(ui.drawer(page)).toContainText('Start from a template');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await expect(ui.drawer(page)).toHaveCount(0);
      await openRow(page, 'PLN-02');
      for (const name of ['Edit', 'Change owner or approver', 'Reassign']) {
        await panelButton(page, name).click();
        await expect(ui.modal(page)).toHaveCount(1);
        await expectOverlayReadable(page);
        await page.keyboard.press('Escape');
        await expect(ui.modal(page)).toHaveCount(0);
      }
      await drawerAction(page, 'Open review').click();
      await expect(dialog(page)).toContainText('Review of PLN-02');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await panel(page).locator('[role="tab"]', { hasText: 'Versions' }).click();
      await expect(panel(page).locator('[data-version]').first()).toBeVisible();
      await expectOverlayReadable(page);
    });
  }
});
