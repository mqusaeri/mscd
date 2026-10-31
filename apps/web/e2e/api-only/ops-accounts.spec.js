import { test, expect, ui, closeDrawer, expectOverlayReadable, expectReadableText } from '../helpers.js';
import { DEMO_PASSWORD, EMAILS, demoCode, freshTotpStep, waitForMail } from '../../e2e-api/fixtures.js';

// The Accounts tab of the operator console against the api (MILESTONE-2 M2-19). The platform operator `ops` signs in
// with its password and authenticator code (it has no membership, so the test session endpoint cannot mint its
// session). The stack runs one organisation; the account routes work in both tenancy modes. Each test starts from the
// seed state (e2e-api/fixtures.js), so the actions change nothing for the other specs. The last test answers the
// organisation creation with the refusal the product owner saw on staging (409 `mail_required` with a detail and no
// message pair) and checks that the dialog shows the server's sentence, never the word "Conflict" alone.
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });
const accounts = (page) => page.locator('main [data-ops-accounts] table tbody tr');
const operators = (page) => page.locator('main [data-ops-operators] table tbody tr');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);

async function signInAsOperator(page) {
  await freshTotpStep();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Work email').fill('ops@mscd.test');
  await page.locator('#au-password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByLabel('Authentication code').fill(demoCode('ops'));
  await expect(ui.title(page)).toHaveText('Operator console');
}

async function openAccounts(page) {
  await signInAsOperator(page);
  await tab(page, 'Accounts').click();
  await expect(accounts(page).first()).toBeVisible();
}

async function manage(page, email) {
  await page.locator('main input[type="search"]').fill(email);
  await expect(accounts(page)).toHaveCount(1);
  await expect(accounts(page).first()).toContainText(email);
  await accounts(page).first().getByRole('button', { name: 'Manage' }).click();
  await expect(drawer(page)).toContainText(email);
}

async function act(page, action, reason) {
  await drawer(page).getByRole('button', { name: action }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('textarea').fill(reason);
  await dialog(page).getByRole('button', { name: action }).click();
}

test.describe('Operator console, Accounts against the api @api-only', () => {
  test.use({ apiSession: null });

  test('lists the accounts of the service; the drawer shows the memberships and sessions; a password link goes out by email', async ({ page }) => {
    await openAccounts(page);
    await expect(page.locator('main [data-ops-accounts]')).toContainText(EMAILS.rina);
    await expect(operators(page).filter({ hasText: 'ops@mscd.test' })).toContainText('You');
    await expectReadableText(page, 4.5);
    // The list never carries a password hash, a factor secret or the roles inside the organisation.
    const listed = await page.request.get('/api/v1/ops/accounts?pageSize=200');
    expect(listed.status()).toBe(200);
    const text = (await listed.text()).toLowerCase();
    for (const secret of ['password', 'hash', 'secret', 'ms_manager', 'domain_owner']) expect(text, secret).not.toContain(secret);

    await manage(page, EMAILS.sari);
    await expect(drawer(page)).toContainText('PT Nusantara Digital Teknologi');
    await expect(drawer(page)).toContainText('Set up');
    await expectOverlayReadable(page);
    await act(page, 'Send password link', 'Asked by the person by phone, identity checked');
    await expect(dialog(page)).toContainText(`A link to set a new password was emailed to ${EMAILS.sari}.`);
    await waitForMail(EMAILS.sari, /reset-password#token=([A-Za-z0-9_-]+)/);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(drawer(page)).toContainText('Asked by the person by phone, identity checked');
  });

  test('resets a second factor, ends the sessions, disables and enables an account; the own account keeps its sessions', async ({ page }) => {
    await openAccounts(page);
    await manage(page, EMAILS.hendra);
    await act(page, 'Reset second factor', 'Lost phone, identity checked by video call');
    await expect(dialog(page)).toContainText(`The second factor of ${EMAILS.hendra} was reset.`);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(drawer(page)).toContainText('Not set up');
    await act(page, 'Disable account', 'Left the company on 30 September');
    await expect(dialog(page)).toContainText(`${EMAILS.hendra} was disabled.`);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await act(page, 'Enable account', 'Back after the review');
    await expect(dialog(page)).toContainText(`${EMAILS.hendra} can sign in again.`);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(drawer(page)).toContainText('Left the company on 30 September');
    await expect(dialog(page)).toHaveCount(0);
    await closeDrawer(page);

    await manage(page, 'ops@mscd.test');
    await expect(drawer(page)).toContainText('This is your own account.');
    // The operator signs in with an authenticator, but its reset would end the operator's own sessions too.
    await expect(drawer(page).getByRole('button', { name: 'Reset second factor' })).toHaveCount(0);
    await expect(drawer(page).getByRole('button', { name: 'End all sessions' })).toHaveCount(0);
    await expect(drawer(page).getByRole('button', { name: 'Disable account' })).toHaveCount(0);
  });

  test('adds a platform operator, who gets the set-password link by email, and removes it', async ({ page }) => {
    await openAccounts(page);
    await page.getByRole('button', { name: 'Add operator' }).click();
    const inputs = dialog(page).locator('input');
    await inputs.nth(0).fill('dimas.pratama@mscd.test');
    await inputs.nth(1).fill('Dimas Pratama');
    await dialog(page).locator('textarea').fill('Second operator for the on-call rota');
    await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog(page)).toContainText('dimas.pratama@mscd.test is now a platform operator.');
    await waitForMail('dimas.pratama@mscd.test', /reset-password#token=([A-Za-z0-9_-]+)/);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    const row = operators(page).filter({ hasText: 'dimas.pratama@mscd.test' });
    await expect(row).toContainText('Has not set a password yet');
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog(page)).toContainText('Remove Dimas Pratama as platform operator');
    await dialog(page).locator('textarea').fill('Rota ended');
    await dialog(page).getByRole('button', { name: 'Remove' }).click();
    await expect(operators(page).filter({ hasText: 'dimas.pratama@mscd.test' })).toHaveCount(0);
  });

  test('a refusal without a message pair shows the server sentence, never only "Conflict"', async ({ page }) => {
    const detail = 'Mail is required on this installation (mail.required) and the SMTP server smtp.example:587 does not answer. Configure mail.smtp first: invitation links are only sent by email';
    // The rights of a multi tenancy service, and the answers of a service whose mail does not work.
    await page.route(/\/api\/v1\/me(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const me = await response.json();
      me.permissions = { ...me.permissions, org: ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'ops.entitlements.manage', 'license.manage', 'pack.install'] };
      return route.fulfill({ response, json: me });
    });
    await page.route(/\/api\/v1\/ops\/(organizations|plans)(\?.*)?$/, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/plans')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], page: 1, pageSize: 25, total: 0 }) });
      return route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'https://mscd.cyberlentera.com/problems/conflict', title: 'Conflict', status: 409, requestId: 'req-m2-19-0001', detail, messageKey: 'mail_required' }),
      });
    });
    await signInAsOperator(page);
    await ui.pageAction(page, 'Create organisation').click();
    const inputs = dialog(page).locator('input');
    await inputs.nth(0).fill('gamma');
    await inputs.nth(1).fill('PT Gamma Medika');
    await inputs.nth(3).fill('it@gammamedika.co.id');
    await inputs.nth(4).fill('Dewi Lestari');
    await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
    const alert = dialog(page).locator('[role="alert"]').last();
    await expect(alert).toContainText(detail);
    await expect(alert).not.toHaveText(/^\s*Conflict\s*$/);
    await expectOverlayReadable(page);
  });
});
