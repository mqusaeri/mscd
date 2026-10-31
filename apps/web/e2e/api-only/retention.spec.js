import { test, expect, ui, go, openApp, openRow, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Retention and disposal against the api (MILESTONE-3 M3-06, D.8). rina is the Management System Manager of the ISMS of
// PT Nusantara Digital Teknologi (`retention.manage` and `retention.approve`), maya its Internal Auditor (neither). The
// stack runs no worker (e2e-api/stack.mjs), so the daily `retention.review` job never opens a review and the seed has
// none: Due for review, Awaiting approval and the register start empty here. The decision form, approval with the
// proposer refused and rejection are covered by the sample build (e2e/screens/retention.spec.js) and the server tests
// (apps/server/test/int/retention); this spec opens every form the empty lists offer: the rule forms, the hold forms
// and the CSV download of the register.
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
