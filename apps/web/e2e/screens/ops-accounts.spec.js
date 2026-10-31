import { test, expect, ui, openScreen, metaById, closeDrawer, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// The Accounts tab of the operator console in the sample build (MILESTONE-2 M2-19): the account list with search,
// filters and paging, the account drawer with its sessions, memberships, recent activity and actions (each names the
// account and asks for a reason), and the platform operators with Add and Remove. The sample service follows the
// refusals of the server: never the own account, never the system account.
// @sample-only: e2e/api-only/ops-accounts.spec.js checks the same screen against the api.
const meta = metaById('ops');
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });
const accounts = (page) => page.locator('main [data-ops-accounts] table tbody tr');
const operators = (page) => page.locator('main [data-ops-operators] table tbody tr');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);

async function openAccounts(page, query = '') {
  await openScreen(page, meta, query);
  await tab(page, query.includes('lang=id') ? 'Akun' : 'Accounts').click();
  await expect(accounts(page).first()).toBeVisible();
}

async function manage(page, name) {
  await page.locator('main input[type="search"]').fill(name);
  // The search runs a moment after typing: wait for the row of this name, not the one row of an earlier search.
  await expect(accounts(page)).toHaveCount(1);
  await expect(accounts(page).first()).toContainText(name);
  await accounts(page).first().locator('button', { hasText: /^(Manage|Kelola)$/ }).click();
  await expect(drawer(page)).toBeVisible();
}

test.describe('Operator console, Accounts @sample-only', () => {
  test('lists every account with search and filters, readable at the layout widths', async ({ page }) => {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await openAccounts(page);
      const main = page.locator('main');
      await expect(main).toContainText('The roles inside an organisation are not shown');
      await expect(accounts(page).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoTextOverflow(page);
      await expectReadableText(page, 4.5);
    }
    // The organisation filter shows once the organisations are read.
    await expect(page.locator('main [data-account-filters] select')).toHaveCount(3);
    await page.locator('main input[type="search"]').fill('rina');
    await expect(accounts(page)).toHaveCount(1);
    await expect(accounts(page).first()).toContainText('rina.kusuma@nusantaradigital.co.id');
    await expect(accounts(page).first()).toContainText('Tenant Admin');
    await page.locator('main input[type="search"]').fill('');
    await page.locator('main [data-account-filters] select').nth(1).selectOption('invited');
    await expect(accounts(page)).toHaveCount(2);
    await expect(page.locator('main [data-ops-accounts]')).toContainText('Lina Marlina');
    await page.locator('main [data-account-filters] select').nth(1).selectOption('');
    await page.locator('main [data-account-filters] select').nth(2).selectOption('system');
    await expect(accounts(page)).toHaveCount(1);
    await expect(accounts(page).first()).toContainText('System account');
    await page.locator('main [data-account-filters] select').nth(2).selectOption('');
    await page.locator('main [data-account-filters] select').nth(0).selectOption('bsd');
    await expect(page.locator('main [data-ops-accounts]')).toContainText('Agus Salim');
    await expect(page.locator('main [data-ops-accounts]')).not.toContainText('Hendra Wijaya');
  });

  test('the drawer shows sessions, memberships and activity; Reset second factor names the account and asks for a reason', async ({ page }) => {
    await openAccounts(page);
    await manage(page, 'Rina Kusuma');
    await expect(drawer(page)).toContainText('rina.kusuma@nusantaradigital.co.id');
    await expect(drawer(page)).toContainText('203.0.113.0/24');
    await expect(drawer(page)).toContainText('Chrome 130, Windows');
    await expect(drawer(page)).toContainText('PT Bank Sentosa Digital');
    await expect(drawer(page)).toContainText('Signed in');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: 'Reset second factor' }).click();
    await expect(dialog(page)).toContainText('Reset second factor: Rina Kusuma');
    await expect(dialog(page)).toContainText('Rina Kusuma (rina.kusuma@nusantaradigital.co.id)');
    await expect(dialog(page)).toContainText('The authenticator app and the recovery codes of the account stop working.');
    await dialog(page).locator('textarea').fill('ok');
    await dialog(page).locator('button', { hasText: 'Reset second factor' }).click();
    await expect(dialog(page)).toContainText('Give a reason of at least 3 characters.');
    await expectOverlayReadable(page);
    await dialog(page).locator('textarea').fill('Lost phone, identity checked by video call');
    await dialog(page).locator('button', { hasText: 'Reset second factor' }).click();
    await expect(dialog(page)).toContainText('The second factor of rina.kusuma@nusantaradigital.co.id was reset.');
    await expect(dialog(page)).toContainText('2 session(s) ended.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(drawer(page)).toContainText('Not set up');
    await expect(drawer(page)).toContainText('Lost phone, identity checked by video call');
    await expect(drawer(page)).toContainText('The account is not signed in anywhere.');
  });

  test('disables and enables an account, sends an invitation again, and keeps the own account', async ({ page }) => {
    await openAccounts(page);
    await manage(page, 'Hendra Wijaya');
    await drawer(page).locator('button', { hasText: 'Disable account' }).click();
    await expect(dialog(page)).toContainText('The account cannot sign in to any organisation, and every session ends.');
    await dialog(page).locator('textarea').fill('Left the company on 30 September');
    await dialog(page).locator('button', { hasText: 'Disable account' }).click();
    await expect(dialog(page)).toContainText('hendra.wijaya@nusantaradigital.co.id was disabled. 1 session(s) were ended.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(drawer(page).locator('button', { hasText: 'Enable account' })).toBeVisible();
    await drawer(page).locator('button', { hasText: 'Enable account' }).click();
    await dialog(page).locator('textarea').fill('Back after the review');
    await dialog(page).locator('button', { hasText: 'Enable account' }).click();
    await expect(dialog(page)).toContainText('hendra.wijaya@nusantaradigital.co.id can sign in again.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await closeDrawer(page);

    await manage(page, 'Lina Marlina');
    // An invited account is neither disabled nor enabled: it becomes active when the person accepts.
    await expect(drawer(page)).toContainText('This account becomes active when the person accepts the invitation. It can be disabled after that.');
    await expect(drawer(page).locator('button', { hasText: 'Disable account' })).toHaveCount(0);
    await drawer(page).locator('button', { hasText: 'Send the invitation to PT Nusantara Digital Teknologi again' }).click();
    await expect(dialog(page)).toContainText('The older invitation links of this membership stop working.');
    await dialog(page).locator('textarea').fill('The first email went to spam');
    await dialog(page).locator('button', { hasText: 'Send the invitation to PT Nusantara Digital Teknologi again' }).click();
    await expect(dialog(page)).toContainText('A new invitation to PT Nusantara Digital Teknologi was emailed to lina.marlina@nusantaradigital.co.id.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await closeDrawer(page);

    await manage(page, 'Platform Operator');
    await expect(drawer(page)).toContainText('This is your own account.');
    // The own second factor is set up, but its reset would end the operator's own sessions too.
    await expect(drawer(page)).toContainText('Replace your authenticator app on My account.');
    await expect(drawer(page).locator('button', { hasText: 'Reset second factor' })).toHaveCount(0);
    await expect(drawer(page).locator('button', { hasText: 'End all sessions' })).toHaveCount(0);
    await expect(drawer(page).locator('button', { hasText: 'Disable account' })).toHaveCount(0);
  });

  test('adds a platform operator and removes one; the own row has no Remove', async ({ page }) => {
    await openAccounts(page);
    await expect(operators(page)).toHaveCount(2);
    await expect(operators(page).filter({ hasText: 'You' }).locator('button', { hasText: 'Remove' })).toHaveCount(0);
    await page.locator('main button', { hasText: 'Add operator' }).click();
    await dialog(page).locator('button', { hasText: /^Add$/ }).click();
    await expect(dialog(page)).toContainText('Enter a valid email address.');
    await expectOverlayReadable(page);
    const inputs = dialog(page).locator('input');
    await inputs.nth(0).fill('dimas.pratama@mscd.example');
    await inputs.nth(1).fill('Dimas Pratama');
    await dialog(page).locator('textarea').fill('Second operator for the on-call rota');
    await dialog(page).locator('button', { hasText: /^Add$/ }).click();
    await expect(dialog(page)).toContainText('dimas.pratama@mscd.example is now a platform operator.');
    await dialog(page).locator('button', { hasText: 'Close' }).click();
    await expect(operators(page)).toHaveCount(3);
    await expect(operators(page).filter({ hasText: 'Dimas Pratama' })).toContainText('Has not set a password yet');
    await operators(page).filter({ hasText: 'Nadia Putri' }).locator('button', { hasText: 'Remove' }).click();
    await expect(dialog(page)).toContainText('Remove Nadia Putri as platform operator');
    await expect(dialog(page)).toContainText('nadia.putri@mscd.example');
    await dialog(page).locator('textarea').fill('Left the operations team');
    await dialog(page).locator('button', { hasText: 'Remove' }).click();
    await expectToast(page, 'nadia.putri@mscd.example is no longer a platform operator');
    await expect(operators(page)).toHaveCount(2);
  });

  for (const theme of ['light', 'dark']) {
    test(`the Accounts tab, its drawer and its dialogs are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openAccounts(page, `lang=id&theme=${theme}`);
      await expect(page.locator('main')).toContainText('Peran di dalam organisasi tidak ditampilkan');
      await expectReadableText(page, 4.5);
      await expectNoTextOverflow(page);
      await manage(page, 'Sari Wulandari');
      await expect(drawer(page)).toContainText('Terkunci');
      await expectOverlayReadable(page);
      await drawer(page).locator('button', { hasText: 'Akhiri semua sesi' }).click();
      await expect(dialog(page)).toContainText('Akhiri semua sesi: Sari Wulandari');
      await expectOverlayReadable(page);
      await dialog(page).locator('button', { hasText: 'Batal' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await closeDrawer(page);
      await page.locator('main button', { hasText: 'Tambah operator' }).click();
      await expect(dialog(page)).toContainText('Tambah operator platform');
      await expectOverlayReadable(page);
    });
  }
});
