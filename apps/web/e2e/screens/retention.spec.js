import {
  test, expect, ui, openScreen, openApp, go, openRow, search, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow,
  expectNoTextOverflow,
} from '../helpers.js';

// Retention and disposal of the sample build (MILESTONE-3 M3-06, D.8): the records of the ISMS due for review with the
// record type filter, multi-select and the decision form (keep until a date, propose disposal), "Place on hold" from a
// row, disposals awaiting approval with "Approve" disabled for the persona's own proposal ("You proposed this
// disposal"), approval and rejection of another manager's proposal, holds with "New hold" and "Release", the disposal
// register with "Export CSV" and "File removed", the rules with "Edit" and "Reset to default", the retention panel of a
// document and of an evidence item, and the Indonesian screen. @sample-only: the API project covers the screen in
// e2e/api-only/retention.spec.js.
const meta = metaById('retention');
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

test.describe('Retention and disposal @sample-only', () => {
  test('lists the records due for review, filters them and keeps two of them until a date', async ({ page }) => {
    await openScreen(page, meta);
    await expect(tab(page, 'Due for review')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/retention\?ms=isms/);
    await expect(rows(page).first()).toBeVisible();
    const before = await rows(page).count();
    expect(before).toBeGreaterThanOrEqual(4);
    await expect(page.locator('main')).toContainText('Disposal rejected: The auditor asked to keep it until the surveillance audit');
    await expect(button(page.locator('main'), 'Decide')).toBeDisabled();
    await expect(page.locator('main')).toContainText('Select at least one record first.');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);

    await page.locator('main select[name="recordClass"]').selectOption('finding');
    await expect(rows(page)).toHaveCount(1);
    await page.locator('main select[name="recordClass"]').selectOption('');
    await expect(rows(page)).toHaveCount(before);

    await rows(page).nth(0).locator('input[type="checkbox"]').check();
    await rows(page).nth(1).locator('input[type="checkbox"]').check();
    await button(page.locator('main'), 'Decide for 2 selected').click();
    await expect(dialog(page)).toContainText('Decide on 2 record(s)');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save decision').click();
    await expect(dialog(page)).toContainText('Choose a decision.');
    await expect(dialog(page)).toContainText('Enter a reason.');
    await dialog(page).getByLabel('Keep until a date').check();
    await dialog(page).locator('input[name="keepUntil"]').fill('2027-06-30');
    await dialog(page).locator('textarea[name="reason"]').fill('Kept for the customer audit of 2027');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 2 record(s)');
    await expect(dialog(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(before - 2);

    await openTab(page, 'Disposal register');
    await expect(row(page, 'Kept for the customer audit of 2027')).toHaveCount(2);
    await expect(row(page, 'Kept for the customer audit of 2027').first()).toContainText('Kept until 30 Jun 2027');
  });

  test('proposes a disposal; the persona cannot approve its own, approves another manager\'s and rejects one', async ({ page }) => {
    await openScreen(page, meta);
    const target = rows(page).first();
    const code = (await target.locator('strong').innerText()).trim();
    await target.locator('input[type="checkbox"]').check();
    await button(page.locator('main'), 'Decide for 1 selected').click();
    await dialog(page).getByLabel('Propose disposal').check();
    await expect(dialog(page)).toContainText('A second person must approve.');
    await expect(dialog(page)).toContainText('MSCD never deletes files in your repositories.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Period over; replaced by later records');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 record(s)');
    await expect(row(page, code)).toHaveCount(0);

    await openTab(page, 'Awaiting approval');
    const mine = row(page, code);
    await expect(mine).toContainText('Rina Kusuma');
    await expect(mine.locator('button', { hasText: /^Approve$/ })).toBeDisabled();
    await expect(mine).toContainText('You proposed this disposal');
    const theirs = row(page, 'Sari Wulandari');
    await expect(theirs.locator('button', { hasText: /^Approve$/ })).toBeEnabled();
    const theirCode = (await theirs.locator('strong').innerText()).trim();
    await button(theirs, 'Approve').click();
    await expect(dialog(page)).toContainText(`Approve the disposal of ${theirCode}`);
    await expect(dialog(page)).toContainText('cannot be undone');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Approve and dispose').click();
    await expectToast(page, `${theirCode} disposed of`);
    await expect(row(page, theirCode)).toHaveCount(0);

    await button(mine, 'Reject').click();
    await expect(dialog(page)).toContainText(`Reject the disposal of ${code}`);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Reject').click();
    await expect(dialog(page)).toContainText('Enter a reason.');
    await dialog(page).locator('textarea[name="note"]').fill('Keep it until the surveillance audit');
    await button(dialog(page), 'Reject').click();
    await expectToast(page, `Disposal of ${code} sent back to review`);

    await openTab(page, 'Due for review');
    await expect(row(page, code)).toContainText('Disposal rejected: Keep it until the surveillance audit');
    await openTab(page, 'Disposal register');
    await expect(row(page, theirCode)).toContainText('Disposed of');
    await expect(row(page, theirCode)).toContainText('Content deleted from the Managed Vault');
  });

  test('places a record on hold from the list and from New hold, and releases a hold', async ({ page }) => {
    await openScreen(page, meta);
    const target = rows(page).first();
    const code = (await target.locator('strong').innerText()).trim();
    await button(target, 'Place on hold').click();
    await expect(dialog(page)).toContainText(`Record: ${code}`);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Dispute with a supplier');
    await button(dialog(page), 'Place on hold').click();
    await expectToast(page, `${code} is on hold`);
    await expect(row(page, code)).toHaveCount(0);

    await openTab(page, 'Holds');
    await expect(row(page, code)).toContainText('In force');
    await expect(row(page, 'NC-2024-07')).toContainText('Released by Rina Kusuma');
    await expect(row(page, 'NC-2024-07')).toContainText('Claim settled');
    await button(page.locator('main'), 'New hold').click();
    await expect(dialog(page)).toContainText('Place a record on hold');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Place on hold').click();
    await expect(dialog(page)).toContainText('Choose a record type.');
    await expect(dialog(page)).toContainText('Enter the code of the record.');
    await dialog(page).locator('select[name="recordClass"]').selectOption('corrective_action');
    await dialog(page).locator('input[name="code"]').fill('CA-2026-04');
    await dialog(page).locator('textarea[name="reason"]').fill('Investigation by the compliance function');
    await button(dialog(page), 'Place on hold').click();
    await expectToast(page, 'CA-2026-04 is on hold');
    await button(row(page, 'CA-2026-04'), 'Release').click();
    await expect(dialog(page)).toContainText('Release the hold on CA-2026-04');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Investigation closed');
    await button(dialog(page), 'Release').click();
    await expectToast(page, 'Hold released');
    await expect(row(page, 'CA-2026-04')).toContainText('Investigation closed');
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('exports the disposal register and records a file the owner removed', async ({ page }) => {
    await openScreen(page, meta);
    await openTab(page, 'Disposal register');
    await expect(rows(page)).toHaveCount(3);
    const asked = row(page, 'Owner asked to delete the file in your repository');
    await expect(asked).toHaveCount(1);
    const [download] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Export CSV').click()]);
    expect(download.suggestedFilename()).toMatch(/^disposal-register-isms-\d{4}-\d{2}-\d{2}\.csv$/);
    await button(asked, 'File removed').click();
    await expectToast(page, 'Removal of the file recorded');
    await expect(asked).toContainText('Owner removed the file');
    await expect(asked.locator('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('sets the period of a record type with its basis and resets it to the default', async ({ page }) => {
    await openScreen(page, meta);
    await openTab(page, 'Rules');
    await expect(page).toHaveURL(/tab=rules/);
    await expect(rows(page)).toHaveCount(14);
    const findings = row(page, 'Closed findings');
    await expect(findings).toContainText('36 months');
    await expect(findings).toContainText('Default');
    await button(findings, 'Edit').click();
    await expect(dialog(page)).toContainText('Retention period of Closed findings');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="months"]').fill('0');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('Enter a whole number from 1 to 1200.');
    await expect(dialog(page)).toContainText('Say why this period applies.');
    await dialog(page).locator('input[name="months"]').fill('60');
    await dialog(page).locator('textarea[name="basis"]').fill('Customer contract clause 12.3');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Retention period saved');
    await expect(findings).toContainText('60 months');
    await expect(findings).toContainText('Set');
    await expect(findings).toContainText('Customer contract clause 12.3');
    await button(findings, 'Reset to default').click();
    await expect(dialog(page)).toContainText('Reset Closed findings to the default');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="basis"]').fill('Back to one certification cycle');
    await button(dialog(page), 'Reset to default').click();
    await expectToast(page, 'Retention period reset to the default');
    await expect(findings).toContainText('36 months');
    await expect(findings).toContainText('Default');
    await expectNoTextOverflow(page);
  });

  test('shows the retention panel of a document and of an evidence item', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await openRow(page, 'IMS-01');
    const panel = ui.drawer(page).locator('[data-retention="panel"]');
    await expect(panel).toContainText('Retention');
    await expect(panel).toContainText('Earlier versions are kept 36 months after a newer version is approved (default).');
    await expect(panel).toContainText('The version before v3.0 is kept until');
    await expectOverlayReadable(page);
    await button(panel, 'Open Retention and disposal').click();
    await expect(page.locator('main h1')).toHaveText('Retention and disposal');

    await go(page, 'Evidence freshness');
    await search(page, 'EV-0124');
    await openRow(page, 'EV-0124');
    const evidence = ui.drawer(page).locator('[data-retention="panel"]');
    await expect(evidence).toContainText('Earlier files are kept 36 months after a newer file replaces them (default).');
    await expect(evidence).toContainText('A file replaced today would be kept until');
    await expectOverlayReadable(page);
  });

  test('speaks Indonesian', async ({ page }) => {
    await openScreen(page, meta, 'lang=id');
    await expect(tab(page, 'Jatuh tempo tinjauan')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('main thead')).toContainText('Retensi berakhir');
    await openTab(page, 'Aturan');
    await expect(page.locator('main')).toContainText('Masa retensi');
    await expect(row(page, 'Temuan yang ditutup')).toContainText('36 bulan');
    await openTab(page, 'Register pemusnahan');
    await expect(button(page.locator('main'), 'Ekspor CSV')).toBeVisible();
  });
});
