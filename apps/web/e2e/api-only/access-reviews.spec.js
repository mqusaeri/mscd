import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Access reviews against the api (MILESTONE-3 M3-07, D.9). In the Test Organisation tenant.admin and rina are the two
// Tenant Admins, rina is the only Management System Manager of the ISMS and the guest Eko Santoso holds an auditor
// grant there. tenant.admin sets a 3-month schedule and starts a review; rina decides the ISMS items, cannot decide her
// own role, revokes the guest grant, signs off into the A.5.18 evidence and decides tenant.admin's organisation items;
// tenant.admin applies the business role revocation rina decided, decides the other organisation items, removes bagus's
// linked company sign-in and completes the review with the single-reviewer warning; the evidence item holds the new
// file and the report downloads as CSV. Every form is readable in the light and dark themes.
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const card = (page, title) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: new RegExp(title) }) });
const rows = (scope) => scope.locator('table tbody tr');
const personRows = (scope, name) => rows(scope).filter({ has: scope.page().locator('td strong[data-person]', { hasText: new RegExp(`^${name}$`) }) });

async function signIn(page, baseURL, handle, org) {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

async function memberId(page, baseURL, handle) {
  const list = await (await page.request.get(`${baseURL}/api/v1/admin/users?pageSize=200`)).json();
  return list.items.find((u) => u.handle === handle).id;
}

/** An enabled SAML provider of tst (SAML needs no discovery), with a certificate from the mock providers' build. */
async function samlProvider() {
  const { createSelfSignedCertificate } = await import('../../../../tools/mock-providers/dist/certs.js');
  const certificate = createSelfSignedCertificate({ commonName: 'mscd-e2e-m3-07', notBefore: new Date('2026-01-01T00:00:00Z'), days: 3650 });
  return {
    slug: 'ad-fs', kind: 'saml', displayName: 'Sign in with AD FS', icon: 'generic',
    saml: {
      entryPoint: 'https://adfs.e2e.example/adfs/ls/', idpIssuer: 'http://adfs.e2e.example/adfs/services/trust', idpCerts: [certificate.certificatePem],
      spEntityId: 'http://localhost:4174/api/v1/auth/saml/ad-fs/metadata', mfaAuthnContexts: ['http://schemas.microsoft.com/claims/multipleauthn'],
    },
    requireMfaClaim: true, mfaFallback: 'local_totp', jitProvisioning: false, allowedEmailDomains: [],
  };
}

/** The evidence of the ISMS snapshot by code. */
async function evidenceOf(page, baseURL, code) {
  const res = await page.request.get(`${baseURL}/api/v1/ui/ms/isms`);
  const text = await res.text();
  expect(res.ok(), `GET /api/v1/ui/ms/isms: ${res.status()} ${text.slice(0, 300)}`).toBe(true);
  const snap = JSON.parse(text);
  expect(snap.bundle, Object.keys(snap).join(',')).toBeTruthy();
  return snap.bundle.evs.find((e) => e.code === code);
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openReview(page) {
  await go(page, 'Access reviews');
  await button(card(page, '^Open review'), 'Open review').click();
  await expect(page.locator('main [data-review]')).toBeVisible();
  await expect(card(page, '^Organisation access')).toBeVisible();
}

/** Selects every undecided item a card shows and decides "keep" for them. */
async function keepTheRest(page, scope) {
  await scope.locator('select[name="decided"]').selectOption('undecided');
  if ((await scope.getByLabel('Select every item shown').count()) === 0) return;
  await scope.getByLabel('Select every item shown').check();
  await scope.locator('.mx-card-head button', { hasText: /^Decide for \d+ selected$/ }).click();
  await dialog(page).getByLabel('Keep: the access is still needed').check();
  await button(dialog(page), 'Save decision').click();
  await expectToast(page, /Decision saved for \d+ item\(s\)/);
  await expect(dialog(page)).toHaveCount(0);
}

test.describe('Access reviews against the api @api-only', () => {
  test.use({ apiSession: 'tenant.admin' });

  test('a whole review: schedule, start, the ISMS signed off by rina, revocations applied by tenant.admin, completed and filed as evidence', async ({ page, baseURL }) => {
    test.slow();
    // bagus has a linked company sign-in of tst before the review opens.
    await apiWrite(page, baseURL, 'POST', '/api/v1/admin/identity-providers', await samlProvider());
    await apiWrite(page, baseURL, 'POST', `/api/v1/admin/users/${await memberId(page, baseURL, 'bagus')}/identities`, { provider: 'ad-fs', subject: 'bagus.prasetyo@adfs.e2e.example' });

    // tenant.admin: every 3 months from 31 Dec, then "Start review now".
    await openApp(page);
    await go(page, 'Access reviews');
    await expect(card(page, '^Open review')).toContainText('No access review is open');
    await expectReadableText(page, 4.5);
    await button(card(page, '^Schedule'), 'Change schedule').click();
    await expect(dialog(page)).toContainText('Access review schedule');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="frequencyMonths"]').selectOption('3');
    await dialog(page).locator('input[name="nextDueOn"]').fill('2026-12-31');
    await button(dialog(page), 'Save schedule').click();
    await expectToast(page, 'Schedule saved');
    await expect(card(page, '^Schedule')).toContainText('Every 3 months');
    await expect(card(page, '^Schedule')).toContainText('31 Dec 2026');
    await button(card(page, '^Open review'), 'Start review now').click();
    await expectToast(page, /Access review AR-2026-01 started with \d+ item\(s\) to review/);
    await expect(page.locator('main [data-review]')).toBeVisible();
    await expect(card(page, '^Systems')).toContainText('ISMS');
    const own = personRows(card(page, '^Organisation access'), 'Tenant Admin');
    await expect(own.first()).toContainText('Your own access: another reviewer decides it');

    // rina, the ISMS manager and the other Tenant Admin.
    await signIn(page, baseURL, 'rina', 'tst');
    await openApp(page);
    await go(page, 'Access review of this system');
    const head = card(page, '^ISMS in access review AR-2026-01');
    await expect(head).toBeVisible();
    const items = card(page, '^Business roles and guest auditors');
    const rinaRole = personRows(items, 'Rina Kusuma').filter({ hasText: 'Management System Manager' });
    await expect(rinaRole).toContainText('Needs a second reviewer');
    await expect(rinaRole.locator('button')).toHaveCount(0);
    const guest = personRows(items, 'Eko Santoso');
    await button(guest, 'Decide').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await dialog(page).locator('textarea[name="note"]').fill('The certification audit ended');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    await button(guest, 'Revoke guest access').click();
    await expectToast(page, 'Guest access revoked; the auditor was signed out');
    await expect(guest).toContainText('Applied');
    const bagusRole = personRows(items, 'Bagus Prasetyo');
    await button(bagusRole, 'Decide').click();
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await dialog(page).locator('textarea[name="note"]').fill('Moved to the finance team');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    await keepTheRest(page, items);
    await expect(rows(items)).toHaveCount(1);
    await button(head, 'Sign off').click();
    await expect(dialog(page)).toContainText('covers control A.5.18 (access rights) and is proposed.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    const signOffText = await dialog(page).innerText();
    const evidenceCode = /([A-Z]{2}-\d{4}) covers control A\.5\.18/.exec(signOffText)?.[1];
    expect(evidenceCode, signOffText).toBeTruthy();
    const before = await evidenceOf(page, baseURL, evidenceCode);
    await button(dialog(page), 'Sign off').click();
    await expectToast(page, `ISMS signed off; its rows are filed to ${evidenceCode} when the review completes`);
    await expect(head).toContainText('Signed off');

    // rina decides tenant.admin's organisation items.
    await openReview(page);
    const org = card(page, '^Organisation access');
    for (const row of await personRows(org, 'Tenant Admin').all()) {
      await button(row, 'Decide').click();
      await dialog(page).getByLabel('Keep: the access is still needed').check();
      await button(dialog(page), 'Save decision').click();
      await expectToast(page, 'Decision saved for 1 item(s)');
    }

    // tenant.admin applies, decides the rest, removes the linked sign-in and completes.
    await signIn(page, baseURL, 'tenant.admin', 'tst');
    await openApp(page);
    await openReview(page);
    const apply = card(page, '^Revocations and changes to apply');
    const waiting = personRows(apply, 'Bagus Prasetyo');
    await expect(waiting).toContainText('Moved to the finance team');
    await button(waiting, 'Apply').click();
    await expectToast(page, 'Role revoked');
    await expect(personRows(apply, 'Bagus Prasetyo')).toHaveCount(0);
    const orgCard = card(page, '^Organisation access');
    await orgCard.locator('select[name="kind"]').selectOption('linked_sign_in');
    const linked = personRows(orgCard, 'Bagus Prasetyo');
    await expect(linked).toContainText('ad-fs');
    await button(linked, 'Decide').click();
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await dialog(page).locator('textarea[name="note"]').fill('Signs in with the password only');
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    await button(personRows(apply, 'Bagus Prasetyo'), 'Apply').click();
    await expectToast(page, 'Linked sign-in removed');
    await orgCard.locator('select[name="kind"]').selectOption('');
    await keepTheRest(page, orgCard);

    const reviewHead = page.locator('main [data-review] section.mx-card').first();
    await button(reviewHead, 'Complete').click();
    await expectToast(page, 'Access review AR-2026-01 completed; the rows of 1 system(s) were filed as evidence');
    await expect(reviewHead).toContainText('Completed');
    await expect(page.locator('main')).toContainText('Not reviewed by a second person: Rina Kusuma');
    await expect(card(page, '^Systems')).toContainText(evidenceCode);

    // The report downloads as CSV; the evidence item holds the new file (read as rina: tenant.admin holds no ISMS role).
    const [download] = await Promise.all([page.waitForEvent('download'), button(reviewHead, 'Download report').click()]);
    expect(download.suggestedFilename()).toBe('access-review-AR-2026-01-tst.csv');
    const text = await readFile(await download.path(), 'utf8');
    expect(text.split(/\r\n/)[0]).toMatch(/^review_no,opened_on,due_on,system,item_kind,person,handle,role,/);
    expect(text).toContain('auditor_access.revoked');
    expect(text).toContain('identity.unlinked');
    await signIn(page, baseURL, 'rina', 'tst');
    const after = await evidenceOf(page, baseURL, evidenceCode);
    expect(after.hash).not.toBe(before.hash);
  });

  test('a review is cancelled with a reason; "Not applied" and "Mark as applied" are readable in both themes', async ({ page, baseURL }) => {
    await apiWrite(page, baseURL, 'POST', '/api/v1/admin/access-reviews', {});
    await openApp(page);
    await openReview(page);
    const org = card(page, '^Organisation access');
    const maya = personRows(org, 'Maya Putri').first();
    await button(maya, 'Decide').click();
    await dialog(page).getByLabel('Revoke: the access is no longer needed').check();
    await button(dialog(page), 'Save decision').click();
    await expectToast(page, 'Decision saved for 1 item(s)');
    const apply = card(page, '^Revocations and changes to apply');
    await button(personRows(apply, 'Maya Putri'), 'Mark as applied').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Cancel').click();
    await button(personRows(apply, 'Maya Putri'), 'Not applied').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Still needed for the open internal audit');
    await button(dialog(page), 'Record as not applied').click();
    await expectToast(page, 'Recorded as not applied');
    await expect(personRows(org, 'Maya Putri').first()).toContainText('Still needed for the open internal audit');

    const head = page.locator('main [data-review] section.mx-card').first();
    await expect(button(head, 'Complete')).toBeDisabled();
    await button(head, 'Cancel review').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Opened before the reorganisation');
    await button(dialog(page), 'Cancel review').click();
    await expectToast(page, 'Access review AR-2026-01 cancelled');
    await expect(head).toContainText('Cancelled');
    await expect(head).toContainText('Opened before the reorganisation');
  });
});

test.describe('Access reviews for a Domain Owner @api-only', () => {
  test.use({ apiSession: 'bagus' });

  test('bagus neither sees the screens nor reads the reviews', async ({ page, baseURL }) => {
    await openApp(page);
    await expect(ui.nav(page, 'Access reviews')).toHaveCount(0);
    await expect(ui.nav(page, 'Access review of this system')).toHaveCount(0);
    expect((await page.request.get(`${baseURL}/api/v1/admin/access-reviews`)).status()).toBe(403);
    expect((await page.request.get(`${baseURL}/api/v1/ms/isms/access-reviews`)).status()).toBe(403);
  });
});
