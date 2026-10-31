import { randomUUID } from 'node:crypto';
import {
  test, expect, ui, go, openApp, openRow, listRow, switchMs, expectToast, expectOverlayReadable, expectReadableText, drawerAction,
} from '../helpers.js';

// Policy read confirmations against the api (MILESTONE-3 M3-05, D.7). In the quality system of the demo organisation
// (Managed Vault) rina makes bagus the owner of the Quality Manual QM-01 and marks it as needing read confirmation;
// bagus submits a new version, which rina approves, so everyone with a role in the QMS is asked to confirm it. bagus
// sees the banner and the task, cannot confirm before he opens the version (ACK-OPEN-FIRST), opens it and confirms.
// rina sees 1 confirmed in the document's detail and in the register, with the person list; hendra (Top Management)
// sees the totals only (product decision 2). hendra has no file rights in the QMS: he reaches "Policies to confirm" from
// the sidebar, opens the version through his read confirmation (an address for him and that version only) and
// confirms it. rina closes the request into the evidence item EQ-0136 (clause 7.3, awareness), which then holds a new
// file. Every dialog is readable in both themes.
const panel = (page) => ui.drawer(page).locator('[data-docs-edit]');
const panelButton = (page, name) => panel(page).locator('button', { hasText: new RegExp(`^${name}$`) });
const dialog = (page) => ui.modal(page).last();
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const register = (page) => page.locator('main [data-screen="acknowledgements"]');
const requestRow = (page, code) => register(page).locator('tbody tr', { hasText: code }).first();
const section = (page, code) => ui.drawer(page).locator(`[data-read-confirmation="${code}"]`);
const banner = (page) => page.locator('[data-confirmation-banner]');
const confirmations = (page) => page.locator('main [data-screen="my-confirmations"]');

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

async function apiGet(page, baseURL, url) {
  const res = await page.request.get(`${baseURL}${url}`);
  expect(res.ok(), `${url}: ${res.status()}`).toBe(true);
  return res.json();
}

const listOf = (body) => (Array.isArray(body) ? body : body.items);

/** The snapshot of a system: the id and evidence of a record by its code. */
async function snapshotOf(page, baseURL, ms) {
  const snap = await apiGet(page, baseURL, `/api/v1/ui/ms/${ms}`);
  return {
    ref: (kind, code) => snap.refs[`${ms}:${kind}:${code}`],
    evidence: (code) => snap.bundle.evs.find((e) => e.code === code),
  };
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Policy read confirmations against the api @api-only', () => {
  test.use({ apiSession: null });

  test('a new approved version of QM-01 is confirmed by bagus; rina sees it, hendra sees totals, and the register is filed as evidence', async ({ page, baseURL }) => {
    test.slow();
    await signIn(page, baseURL, 'rina');
    const before = await snapshotOf(page, baseURL, 'qms');
    const doc = before.ref('doc', 'QM-01');
    expect(doc, 'QM-01 in the QMS').toBeTruthy();
    const evidenceBefore = before.evidence('EQ-0136');
    expect(evidenceBefore, 'EQ-0136 in the QMS').toBeTruthy();
    const owner = await apiWrite(page, baseURL, 'PATCH', `/api/v1/ms/qms/documents/${doc.id}`, { ownerHandle: 'bagus' });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);

    // rina marks the Quality Manual as needing read confirmation in its detail.
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Document register');
    await openRow(page, 'QM-01');
    await expect(section(page, 'QM-01')).toContainText('Read confirmation');
    await expect(section(page, 'QM-01').locator('[data-latest]')).toHaveText('No confirmation request for this document yet.');
    // The snapshot does not carry the stored settings yet: the section and the dialog say so, and nothing is saved
    // until rina chose whether people are asked.
    await expect(section(page, 'QM-01').locator('[data-setting]'))
      .toHaveText('The read confirmation settings stored for this document are not shown on this page. Saving new settings replaces them.');
    await button(section(page, 'QM-01'), 'Read confirmation settings').click();
    await expect(dialog(page)).toContainText('Read confirmation of QM-01');
    await expect(dialog(page)).toContainText('The settings stored for this document are not shown here.');
    await expect(dialog(page).getByLabel('Ask people to confirm each new approved version')).not.toBeChecked();
    await expect(dialog(page).getByLabel('Do not ask for read confirmation')).not.toBeChecked();
    await button(dialog(page), 'Save').click();
    await expect(dialog(page).locator('[role="alert"]')).toHaveText('Choose whether people are asked to confirm new versions.');
    await dialog(page).getByLabel('Ask people to confirm each new approved version').check();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Read confirmation of QM-01 saved');
    await expect(section(page, 'QM-01').locator('[data-setting]'))
      .toHaveText('Each new approved version is sent for read confirmation: Everyone with a role in the document\'s systems, 14 days.');

    // bagus, now the owner, submits a new version from the Managed Vault.
    await signIn(page, baseURL, 'bagus');
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Document register');
    await openRow(page, 'QM-01');
    await panelButton(page, 'Upload with change summary').click();
    const chooser = page.waitForEvent('filechooser');
    await ui.modal(page).locator('button', { hasText: 'Upload to Managed Vault' }).click();
    await (await chooser).setFiles({ name: 'Quality-Manual.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% MSCD E2E quality manual\n%%EOF\n') });
    await expect(dialog(page)).toContainText('New version of QM-01');
    await dialog(page).locator('textarea').fill('Quality objectives for 2027 and the new complaint handling process');
    await button(dialog(page), 'Submit for review').click();
    await expectToast(page, /QM-01 v\S+ submitted for review/);

    // rina approves it: the approval opens the request for everyone with a role in the QMS.
    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Document register');
    await openRow(page, 'QM-01');
    await drawerAction(page, 'Open review').click();
    await expect(dialog(page)).toContainText('Review of QM-01');
    await button(dialog(page), 'Approve').click();
    await expectToast(page, /QM-01 v\S+ approved/);
    const requests = listOf(await apiGet(page, baseURL, '/api/v1/ms/qms/acknowledgement-requests'));
    const request = requests.find((r) => r.document.code === 'QM-01' && r.status === 'open');
    expect(request, 'the open request of QM-01').toBeTruthy();
    const version = request.version.label;
    const audience = request.totals.audience;
    expect(version).not.toBe('5.0');
    expect(audience).toBeGreaterThan(1);
    expect(request.totals).toMatchObject({ confirmed: 0, pending: audience });

    // bagus sees the banner and the task; the api refuses a confirmation before the version is opened.
    await signIn(page, baseURL, 'bagus');
    const mine = listOf(await apiGet(page, baseURL, '/api/v1/me/acknowledgements'));
    const own = mine.find((m) => m.requestId === request.id);
    expect(own).toMatchObject({ status: 'pending', openedAt: null, versionLabel: version, document: { code: 'QM-01' } });
    const early = await apiWrite(page, baseURL, 'POST', `/api/v1/me/acknowledgements/${own.id}/confirm`);
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(early.body).toMatchObject({ rule: 'ACK-OPEN-FIRST' });

    await openApp(page);
    await expect(banner(page)).toHaveAttribute('data-confirmation-banner', '1');
    await expect(banner(page)).toContainText('You have 1 policy to confirm');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    await go(page, 'My Tasks');
    await expect(page.locator('main')).toContainText(`Read and confirm QM-01 Quality Manual, version ${version}, in Policies to confirm`);
    // My Tasks links to the screen that completes the task, and the sidebar entry counts the open confirmation.
    await expect(ui.pageAction(page, 'Policies to confirm')).toBeVisible();
    await expect(ui.nav(page, 'Policies to confirm')).toContainText('1');
    await button(banner(page), 'Open Policies to confirm').click();
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await expect(banner(page)).toHaveCount(0);
    const item = confirmations(page).locator('[data-confirmation="QM-01"]');
    await expect(item).toContainText(`Version ${version}`);
    await expect(item).toContainText('Not opened yet');
    await expect(item).toContainText('Confirm by 13 Oct 2026');
    await expect(button(item, 'Confirm')).toBeDisabled();
    await expect(item).toContainText('Open the document first.');

    const opened = page.waitForResponse((r) => r.url().endsWith(`/api/v1/me/acknowledgements/${own.id}/open`));
    const popup = page.waitForEvent('popup');
    await button(item, 'Open document').click();
    const openAnswer = await opened;
    expect(openAnswer.status()).toBe(200);
    expect((await openAnswer.json()).url).toContain('/content?ms=qms');
    // bagus owns QM-01, so he reads it through the file routes, without a read confirmation token.
    expect((await openAnswer.json()).url).not.toContain('via=acknowledgement');
    await (await popup).close();
    await expect(item).toContainText(/Opened on \d{2} [A-Z][a-z]{2} 2026/);
    await expect(item).toContainText('Tick the statement first.');
    await item.getByLabel('I have read and understood this document').check();
    await button(item, 'Confirm').click();
    await expectToast(page, `You confirmed QM-01 version ${version}`);
    await expect(confirmations(page)).toContainText('Nothing to confirm');
    await expect(confirmations(page).locator('tbody tr', { hasText: 'QM-01' }).first()).toContainText(/Confirmed on/);

    // rina sees 1 confirmed in the document's detail, the register and the person list.
    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Document register');
    await openRow(page, 'QM-01');
    await expect(section(page, 'QM-01').locator('[data-latest]')).toHaveText(`Version ${version}: 1 of ${audience} confirmed`);
    await button(section(page, 'QM-01'), 'Open read confirmations').click();
    await expect(ui.title(page)).toHaveText('Policy read confirmations');
    await expect(ui.drawer(page)).toContainText(`QM-01 version ${version}`);
    await expect(ui.drawer(page).locator('[data-stat="confirmed"] [data-value]')).toHaveAttribute('data-value', '1');
    await expect(ui.drawer(page).locator('tbody tr', { hasText: 'Bagus Prasetyo' })).toContainText('Confirmed');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);
    await go(page, 'Document register');
    await ui.pageAction(page, 'Read confirmations').click();
    await expect(ui.title(page)).toHaveText('Policy read confirmations');
    await expect(requestRow(page, 'QM-01')).toContainText(`1 of ${audience}`);
    await expect(requestRow(page, 'QM-01')).toContainText('Open');

    // hendra sees the totals of the request and no names.
    await signIn(page, baseURL, 'hendra');
    const totalsOnly = await apiGet(page, baseURL, `/api/v1/ms/qms/acknowledgement-requests/${request.id}`);
    expect(totalsOnly.totals).toMatchObject({ confirmed: 1, audience });
    expect(totalsOnly.people).toBeUndefined();
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Policy read confirmations');
    await expect(register(page)).toContainText('You see the totals of each request.');
    await expect(requestRow(page, 'QM-01')).toContainText(`1 of ${audience}`);
    await requestRow(page, 'QM-01').click();
    await expect(ui.drawer(page).locator('[data-stat="confirmed"] [data-value]')).toHaveAttribute('data-value', '1');
    await expect(ui.drawer(page).locator('[data-person]')).toHaveCount(0);
    await expect(button(ui.drawer(page), 'Remind')).toHaveCount(0);
    await expect(button(ui.drawer(page), 'Export CSV')).toHaveCount(0);
    await expect(button(ui.drawer(page), 'Close and file as evidence')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);

    // hendra has no file rights in the QMS: the file routes refuse him the Managed Vault file, and "Open document"
    // gives him an address that opens this version for him through his read confirmation. He then confirms it.
    const hendraOwn = listOf(await apiGet(page, baseURL, '/api/v1/me/acknowledgements')).find((m) => m.requestId === request.id);
    expect(hendraOwn).toMatchObject({ status: 'pending', openedAt: null });
    await expect(ui.nav(page, 'Policies to confirm')).toContainText('1');
    await ui.nav(page, 'Policies to confirm').click();
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    const hendraItem = confirmations(page).locator('[data-confirmation="QM-01"]');
    await expect(hendraItem).toContainText('Not opened yet');
    await expect(button(hendraItem, 'Confirm')).toBeDisabled();
    const hendraOpened = page.waitForResponse((r) => r.url().endsWith(`/api/v1/me/acknowledgements/${hendraOwn.id}/open`));
    const hendraPopup = page.waitForEvent('popup');
    await button(hendraItem, 'Open document').click();
    const hendraAnswer = await hendraOpened;
    expect(hendraAnswer.status()).toBe(200);
    const hendraUrl = (await hendraAnswer.json()).url;
    expect(hendraUrl).toMatch(/\/content\?ms=qms&inline=true&via=acknowledgement&t=/);
    await (await hendraPopup).close();
    const file = await page.request.get(`${baseURL}${hendraUrl}`);
    expect(file.status()).toBe(200);
    expect((await file.body()).toString('utf8')).toContain('MSCD E2E quality manual');
    expect((await page.request.get(`${baseURL}${hendraUrl.split('&via=')[0]}`)).status()).toBe(403);
    await expect(hendraItem).toContainText(/Opened on \d{2} [A-Z][a-z]{2} 2026/);
    await hendraItem.getByLabel('I have read and understood this document').check();
    await button(hendraItem, 'Confirm').click();
    await expectToast(page, `You confirmed QM-01 version ${version}`);
    await expect(confirmations(page)).toContainText('Nothing to confirm');
    await expect(ui.nav(page, 'Policies to confirm')).not.toContainText(/\d/);
    const afterHendra = await apiGet(page, baseURL, `/api/v1/ms/qms/acknowledgement-requests/${request.id}`);
    expect(afterHendra.totals).toMatchObject({ confirmed: 2, audience });

    // rina closes the request into the evidence of clause 7.3, which then holds a new file.
    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Policy read confirmations');
    await requestRow(page, 'QM-01').click();
    await button(ui.drawer(page), 'Close and file as evidence').click();
    await expect(dialog(page)).toContainText('Close the request of QM-01');
    await dialog(page).locator('input[type="search"]').fill('EQ-0136');
    await dialog(page).locator('[role="option"]', { hasText: 'EQ-0136' }).click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Close and file').click();
    await expectToast(page, 'Request closed. The register is filed as a new file of EQ-0136.');
    await expect(ui.drawer(page)).toContainText('This request is closed. Reminders stopped.');
    await expect(ui.drawer(page)).toContainText('EQ-0136');
    await expect(button(ui.drawer(page), 'Remind')).toHaveCount(0);
    const after = (await snapshotOf(page, baseURL, 'qms')).evidence('EQ-0136');
    expect(after.hash).not.toBe(evidenceBefore.hash);
  });

  test('"Ask for confirmation" sends the current version of an approved policy to the chosen roles, readable in both themes', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina');
    await openApp(page);
    await go(page, 'Policy read confirmations');
    await expect(register(page)).toContainText('No confirmation requests yet');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    await ui.pageAction(page, 'Ask for confirmation').click();
    await expect(dialog(page)).toContainText('The people you choose get a task and a notification');
    await dialog(page).locator('select[name="document"]').selectOption('POL-01');
    await dialog(page).getByLabel('Only the roles I choose').check();
    await dialog(page).getByLabel('Top Management').check();
    await dialog(page).locator('input[name="dueDays"]').fill('7');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Send the request').click();
    await expectToast(page, /^Asked \d+ (person|people) to confirm POL-01 version 4\.0/);
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(requestRow(page, 'POL-01')).toContainText('Open');
    await expect(requestRow(page, 'POL-01')).toContainText('6 Oct 2026');
    await requestRow(page, 'POL-01').click();
    await expect(ui.drawer(page)).toContainText('POL-01 version 4.0');
    await expect(ui.drawer(page)).toContainText('Holders of: Top Management');
    await expect(ui.drawer(page).locator('[data-person="hendra"]')).toHaveText('Hendra Wijaya');
    const download = page.waitForEvent('download');
    await button(ui.drawer(page), 'Export CSV').click();
    expect((await download).suggestedFilename()).toBe('read-confirmations-POL-01-v4.0-2026-09-29.csv');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});
