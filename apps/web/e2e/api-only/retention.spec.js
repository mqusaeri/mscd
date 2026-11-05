import { test, expect, ui, go, openApp, openRow, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Retention and disposal against the api (MILESTONE-3 M3-06, D.8). rina is the Management System Manager of the ISMS of
// PT Nusantara Digital Teknologi (`retention.manage` and `retention.approve`), maya its Internal Auditor (neither). The
// stack runs no worker (e2e-api/stack.mjs), so the daily `retention.review` job never opens a review: in PT Nusantara
// Digital Teknologi Due for review, Awaiting approval and the register start empty, and this spec opens every form the
// empty lists offer (the rule forms, the hold forms and the CSV download of the register).
// The demo seed (MILESTONE-3 E, M3-10) writes one due review in RS Medika Nusantara: the SharePoint file of the
// withdrawn ISMS evidence record EV-0090, kept 12 months. There rina decides on it, wulan (Programme Owner,
// `retention.approve` only) approves or rejects the disposal as the second person while rina's own "Approve" stays
// disabled, and rina records that the owner removed the file in the customer repository.
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text });
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: new RegExp(`^${name}$`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openTab(page, name) {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/** A session of `handle` in the organisation `org` (POST /test/session), replacing the one of the test. */
async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** The ISMS retention screen of RS Medika Nusantara, on the tab `name`. */
async function openRmn(page, name = 'Due for review') {
  await openApp(page, 'retention?ms=isms&org=rmn');
  await expect(ui.title(page)).toHaveText('Retention and disposal');
  await expect(ui.orgButton(page)).toContainText('RS Medika Nusantara');
  if (name !== 'Due for review') await openTab(page, name);
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}

// The seeded due review of RS Medika Nusantara (apps/server/src/seed/milestone3.ts).
const DUE = { code: 'EV-0090 v1.0', title: 'Badge access log of the former server room' };

/** rina proposes the disposal of the seeded due file. */
async function proposeDisposal(page, reason) {
  await openRmn(page);
  const due = row(page, DUE.code);
  await expect(due).toContainText(DUE.title);
  await due.locator('input[type="checkbox"]').check();
  await button(page.locator('main'), 'Decide for 1 selected').click();
  await expect(dialog(page)).toContainText('Decide on 1 record(s)');
  await dialog(page).getByLabel('Propose disposal').check();
  await expect(dialog(page)).toContainText('A second person must approve.');
  await expect(dialog(page)).toContainText('MSCD never deletes files in your repositories.');
  await dialog(page).locator('textarea[name="reason"]').fill(reason);
  return due;
}

test.describe('Retention and disposal against the api @api-only', () => {
  test('rina sets the retention period of closed findings with its basis and resets it to the default', async ({ page }) => {
    await openApp(page);
    await go(page, 'Retention and disposal');
    await expect(tab(page, 'Due for review')).toHaveAttribute('aria-selected', 'true');
    await openTab(page, 'Rules');
    await expect(rows(page)).toHaveCount(14);
    await expect(row(page, 'Earlier document versions').first()).toContainText('Policy');
    const findings = row(page, 'Closed findings');
    await expect(findings).toContainText('36 months');
    await expect(findings).toContainText('Default');
    await expectReadableText(page, 4.5);

    await button(findings, 'Edit').click();
    await expect(dialog(page)).toContainText('Retention period of Closed findings');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="months"]').fill('60');
    await dialog(page).locator('textarea[name="basis"]').fill('Customer contract clause 12.3');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Retention period saved');
    await expect(dialog(page)).toHaveCount(0);
    await expect(findings).toContainText('60 months');
    await expect(findings).toContainText('Set');
    await expect(findings).toContainText('Customer contract clause 12.3');
    const rules = await (await page.request.get('/api/v1/ms/isms/retention/rules')).json();
    expect(rules.find((r) => r.recordClass === 'finding')).toMatchObject({ retainMonths: 60, source: 'set' });

    await button(findings, 'Reset to default').click();
    await expect(dialog(page)).toContainText('Reset Closed findings to the default');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="basis"]').fill('Back to one certification cycle');
    await button(dialog(page), 'Reset to default').click();
    await expectToast(page, 'Retention period reset to the default');
    await expect(findings).toContainText('36 months');
    await expect(findings).toContainText('Default');
  });

  test('rina places a closed finding on hold by its code and releases the hold', async ({ page }) => {
    await openApp(page);
    await go(page, 'Retention and disposal');
    await openTab(page, 'Holds');
    await expect(page.locator('main')).toContainText('No record is on hold');
    await button(page.locator('main'), 'New hold').click();
    await expect(dialog(page)).toContainText('Place a record on hold');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="recordClass"]').selectOption('finding');
    await dialog(page).locator('input[name="code"]').fill('NO-SUCH-1');
    await dialog(page).locator('textarea[name="reason"]').fill('Legal claim by a former supplier');
    await button(dialog(page), 'Place on hold').click();
    await expect(dialog(page).locator('[role="alert"]').first()).toBeVisible();
    await dialog(page).locator('input[name="code"]').fill('NC-2025-01');
    await button(dialog(page), 'Place on hold').click();
    await expectToast(page, 'NC-2025-01 is on hold');
    await expect(dialog(page)).toHaveCount(0);
    const held = row(page, 'NC-2025-01');
    await expect(held).toContainText('In force');
    await expect(held).toContainText('Closed findings');
    await expect(held).toContainText('Rina Kusuma');

    await button(held, 'Release').click();
    await expect(dialog(page)).toContainText('Release the hold on NC-2025-01');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Claim settled');
    await button(dialog(page), 'Release').click();
    await expectToast(page, 'Hold released');
    await expect(held).toContainText('Released by Rina Kusuma');
    await expect(held).toContainText('Claim settled');
    await expect(held.locator('button')).toHaveCount(0);
  });

  test('the review lists start empty and the register downloads as CSV', async ({ page }) => {
    await openApp(page);
    await go(page, 'Retention and disposal');
    await expect(page.locator('main')).toContainText('Nothing is due for review');
    await expect(button(page.locator('main'), 'Decide')).toBeDisabled();
    await openTab(page, 'Awaiting approval');
    await expect(page.locator('main')).toContainText('No disposal waits for approval');
    await openTab(page, 'Disposal register');
    await expect(page.locator('main')).toContainText('No decision yet');
    const [download] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Export CSV').click()]);
    expect(download.suggestedFilename()).toMatch(/^disposal-register-ndt-isms-\d{4}-\d{2}-\d{2}\.csv$/);
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(await download.path(), 'utf8');
    expect(text.split(/\r\n/)[0]).toBe('item_code,item_title,record_class,retention_months,retention_ends_on,status,decision,reason,keep_until,decided_by,decided_at,approved_by,approved_at,disposed_at,file_action,file_removed_at');
  });

  test('a document shows its retention panel', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await openRow(page, 'IMS-01');
    const panel = ui.drawer(page).locator('[data-retention="panel"]');
    await expect(panel).toContainText('Earlier versions are kept 36 months after a newer version is approved (default).');
    await inBothThemes(page, () => expectOverlayReadable(page));
  });
});

test.describe('Retention and disposal for the Internal Auditor @api-only', () => {
  test.use({ apiSession: 'maya' });

  test('maya neither sees the screen nor reads its lists', async ({ page }) => {
    await openApp(page);
    await expect(ui.nav(page, 'Retention and disposal')).toHaveCount(0);
    expect((await page.request.get('/api/v1/ms/isms/retention/rules')).status()).toBe(403);
  });
});

test.describe('Retention review of RS Medika Nusantara against the api @api-only', () => {
  test.use({ apiSession: null });

  test('rina keeps the due file until a date and the register shows the decision', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'rmn');
    await openRmn(page);
    await expect(rows(page)).toHaveCount(1);
    const due = row(page, DUE.code);
    await expect(due).toContainText(DUE.title);
    await expect(button(page.locator('main'), 'Decide')).toBeDisabled();
    await expectReadableText(page, 4.5);
    await due.locator('input[type="checkbox"]').check();
    await button(page.locator('main'), 'Decide for 1 selected').click();
    await expect(dialog(page)).toContainText('Decide on 1 record(s)');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save decision').click();
    await expect(dialog(page)).toContainText('Choose a decision.');
    await dialog(page).getByLabel('Keep until a date').check();
    await dialog(page).locator('input[name="keepUntil"]').fill('2027-06-30');
    await dialog(page).locator('textarea[name="reason"]').fill('Kept until the access control audit of 2027');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 record(s)');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Nothing is due for review');

    await openTab(page, 'Disposal register');
    const kept = row(page, DUE.code);
    await expect(kept).toContainText('Kept until 30 Jun 2027');
    await expect(kept).toContainText('Kept until the access control audit of 2027');
    await expect(kept).toContainText('Rina Kusuma');
  });

  test('rina proposes the disposal, her own Approve stays disabled, wulan approves it and rina records the removed file', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'rmn');
    const due = await proposeDisposal(page, 'Retention period over; the server room was closed in 2025');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 record(s)');
    await expect(due).toHaveCount(0);

    await openTab(page, 'Awaiting approval');
    const mine = row(page, DUE.code);
    await expect(mine).toContainText('Rina Kusuma');
    await expect(mine).toContainText('You proposed this disposal');
    await expect(button(mine, 'Approve')).toBeDisabled();
    await expect(button(mine, 'Reject')).toBeEnabled();
    await expectReadableText(page, 4.5);

    // The Programme Owner approves as the second person (decision 6 of CLAUDE.md, F.6 `retention.approve`).
    await signIn(page, baseURL, 'wulan', 'rmn');
    await openRmn(page, 'Awaiting approval');
    const theirs = row(page, DUE.code);
    await expect(theirs).toContainText('Rina Kusuma');
    await expect(theirs).not.toContainText('You proposed this disposal');
    await expect(button(theirs, 'Approve')).toBeEnabled();
    await button(theirs, 'Approve').click();
    await expect(dialog(page)).toContainText(`Approve the disposal of ${DUE.code}`);
    await expect(dialog(page)).toContainText('cannot be undone');
    // The dialog names the file action the disposal register will record (M3-15): the file is in SharePoint.
    const registerLine = dialog(page).locator('[data-register-file-action="owner_asked"]');
    await expect(registerLine).toContainText('File action in the disposal register');
    await expect(registerLine).toContainText('Owner asked to delete the file in your repository');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Approve and dispose').click();
    await expectToast(page, `${DUE.code} disposed of`);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('main')).toContainText('No disposal waits for approval');

    // The file is in the customer's SharePoint: MSCD asks its owner to delete it, and a manager records the removal.
    await signIn(page, baseURL, 'rina', 'rmn');
    await openRmn(page, 'Disposal register');
    const disposed = row(page, DUE.code);
    await expect(disposed).toContainText('Disposed of');
    await expect(disposed).toContainText('Wulan Hartono');
    await expect(disposed).toContainText('Owner asked to delete the file in your repository');
    await inBothThemes(page, () => expectReadableText(page, 4.5));
    await button(disposed, 'File removed').click();
    await expectToast(page, 'Removal of the file recorded');
    await expect(disposed).toContainText('Owner removed the file');
    await expect(disposed.locator('button')).toHaveCount(0);
  });

  test('wulan rejects the proposed disposal with a note, and the file is due for review again', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'rmn');
    await proposeDisposal(page, 'Retention period over');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 record(s)');

    await signIn(page, baseURL, 'wulan', 'rmn');
    await openRmn(page, 'Awaiting approval');
    const waiting = row(page, DUE.code);
    await button(waiting, 'Reject').click();
    await expect(dialog(page)).toContainText(`Reject the disposal of ${DUE.code}`);
    await expect(dialog(page)).toContainText('The record goes back to Due for review with your note.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Reject').click();
    await expect(dialog(page)).toContainText('Enter a reason.');
    await dialog(page).locator('textarea[name="note"]').fill('Keep it until the badge system migration is audited');
    await button(dialog(page), 'Reject').click();
    await expectToast(page, `Disposal of ${DUE.code} sent back to review`);
    await expect(dialog(page)).toHaveCount(0);
    await expect(waiting).toHaveCount(0);

    await openTab(page, 'Due for review');
    await expect(row(page, DUE.code)).toContainText('Disposal rejected: Keep it until the badge system migration is audited');
    // The Programme Owner holds `retention.approve` only: she reads the list but has no decision form.
    await expect(page.locator('main')).toContainText('You can read this list.');
    await expect(button(page.locator('main'), 'Decide')).toHaveCount(0);
  });
});
