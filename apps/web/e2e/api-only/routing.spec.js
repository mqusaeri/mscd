import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// Routing rules against the api (MILESTONE-2 M2-09, A-37, A-50). In the Test Organisation rina is a Tenant Admin and
// the MS Manager of the ISMS, and tenant.admin is the second Tenant Admin: a rule rina asks for in her own system
// waits for approval (four eyes), she cannot decide on it, and tenant.admin approves it.
const drawer = (page) => ui.drawer(page);
const rules = (page) => page.locator('main table tbody tr');
const select = (page, label) => drawer(page).getByLabel(new RegExp(`^${label}`));

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function darkTheme(page) {
  await page.locator('header button[title="Theme"]').click();
  await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
}

test.describe('Routing rules against the api @api-only', () => {
  test.use({ apiSession: null });

  test('rina asks for a rule that waits for a second Tenant Admin, and tenant.admin approves it', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Routing rules');
    await expect(rules(page).filter({ hasText: 'SharePoint Online' }).first()).toContainText('Active');
    await ui.pageAction(page, 'Add rule').click();
    await select(page, 'System').selectOption({ label: 'ISMS' });
    await select(page, 'Classification of the file').selectOption({ label: 'Confidential' });
    await select(page, 'File kind').selectOption({ label: 'Evidence' });
    await select(page, 'Repository').selectOption({ label: 'Managed Vault' });
    await expect(select(page, 'Storage mode')).toHaveValue('stored');
    await drawer(page).locator('input[name="priority"]').fill('30');
    await drawer(page).locator('textarea[name="note"]').fill('Confidential ISMS evidence to the vault');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'Routing change waiting for approval by another Tenant Admin');
    const asked = rules(page).filter({ hasText: 'Confidential ISMS evidence to the vault' });
    await expect(asked).toContainText('Waiting for approval');
    await expect(asked).toContainText('Requested by Rina Kusuma');
    await expect(asked).toContainText('You asked for this change; another Tenant Admin decides on it.');
    await expect(asked.locator('button', { hasText: 'Approve' })).toBeDisabled();
    await expect(page.locator('main')).toContainText('1 routing change is waiting for approval.');

    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Routing rules');
    const waiting = rules(page).filter({ hasText: 'Confidential ISMS evidence to the vault' });
    await expect(waiting.locator('button', { hasText: 'Edit' })).toHaveCount(0);
    await waiting.locator('button', { hasText: 'Approve' }).click();
    await expectToast(page, 'Routing change approved and active');
    await expect(waiting).toContainText('Active');
    await expect(waiting).toContainText(/Decided by (Tenant Admin|tenant\.admin)/);
    await expect(page.locator('main')).not.toContainText('waiting for approval.');

    // The Edit drawer of the now active rule, in the dark theme (Add rule is checked in light above).
    await darkTheme(page);
    await waiting.locator('button', { hasText: 'Edit' }).click();
    await expect(drawer(page)).toContainText('Edit routing rule');
    await expect(drawer(page).locator('textarea[name="note"]')).toHaveValue('Confidential ISMS evidence to the vault');
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('a Tenant Admin rejects a waiting change after a confirmation', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Routing rules');
    await ui.pageAction(page, 'Add rule').click();
    await select(page, 'System').selectOption({ label: 'ISMS' });
    await select(page, 'File kind').selectOption({ label: 'Documents' });
    await select(page, 'Repository').selectOption({ label: 'SharePoint Online' });
    await select(page, 'Storage mode').selectOption({ label: 'Pass-through' });
    await drawer(page).locator('textarea[name="note"]').fill('ISMS documents pass through');
    await drawer(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'Routing change waiting for approval');

    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Routing rules');
    const waiting = rules(page).filter({ hasText: 'ISMS documents pass through' });
    await darkTheme(page);
    await waiting.locator('button', { hasText: 'Reject' }).click();
    await expect(ui.modal(page)).toContainText('Reject routing change');
    await expectOverlayReadable(page);
    await ui.modal(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Routing change rejected');
    await expect(waiting).toContainText('Rejected');

    // The Add rule drawer in the dark theme.
    await ui.pageAction(page, 'Add rule').click();
    await expect(drawer(page)).toContainText('Add a routing rule');
    await select(page, 'Repository').selectOption({ label: 'SharePoint Online' });
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('Stored files lists the storage objects of the organisation: name, place and hash, never the content', async ({ page, baseURL }) => {
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await go(page, 'Routing rules');
    await page.locator('main [role="tab"]', { hasText: 'Stored files' }).click();
    const files = page.locator('main table tbody tr');
    await expect(files.first()).toBeVisible();
    await expect(page.locator('main')).toContainText(/\d+ of \d+ files/);
    await expect(page.locator('main table thead')).toContainText('Hash and check');
    await page.locator('main select').first().selectOption({ label: 'SharePoint Online' });
    await expect(files.first()).toContainText('SharePoint Online');
    await expect(files.first()).toContainText('ISMS');
    await expect(files.first()).toContainText(/QuickXorHash|SHA-256|No hash/);
  });

  test.describe('as an MS Manager without a storage administration role', () => {
    test.use({ apiSession: 'sari' });
    test('the rules are shown read-only, without Add rule and without the stored files', async ({ page }) => {
      await openApp(page);
      await go(page, 'Routing rules');
      await expect(page.locator('main')).toContainText('You can see the routing rules. A Tenant Admin or Storage Admin adds and changes them.');
      await expect(ui.pageAction(page, 'Add rule')).toHaveCount(0);
      await expect(page.locator('main [role="tab"]')).toHaveCount(0);
      await expect(page.locator('main table tbody tr button')).toHaveCount(0);
    });
  });
});
