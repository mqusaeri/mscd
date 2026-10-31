import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectReadableText } from '../helpers.js';

// Policies to confirm against the api (MILESTONE-3 M3-05, D.7 "Confirming", H.7). rina asks the Domain Owners of the
// ISMS to confirm the Information Security Policy POL-01 (SharePoint, Link mode). bagus sees the banner, puts it off,
// and opens the screen from its sidebar entry, which counts the open confirmation (its address also opens it);
// "Confirm" waits until he has opened the version, which he may read at the
// provider without file rights in the ISMS, and ticked the statement. His confirmation moves to Done and the banner
// goes. A person who is not asked has nothing to confirm. The screen is readable in both themes.
const body = (page) => page.locator('main [data-screen="my-confirmations"]');
const banner = (page) => page.locator('[data-confirmation-banner]');
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

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

/** rina asks the Domain Owners of the ISMS to confirm POL-01; the request's answer. */
async function askDomainOwners(page, baseURL) {
  await signIn(page, baseURL, 'rina');
  const snap = await (await page.request.get(`${baseURL}/api/v1/ui/ms/isms`)).json();
  const doc = snap.refs['isms:doc:POL-01'];
  expect(doc, 'POL-01 in the ISMS').toBeTruthy();
  const asked = await apiWrite(page, baseURL, 'POST', '/api/v1/ms/isms/acknowledgement-requests', {
    documentId: doc.id, audience: { scope: 'roles', roles: ['domain_owner'] }, dueDays: 14,
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  return asked.body;
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Policies to confirm against the api @api-only', () => {
  test.use({ apiSession: null });

  test('bagus puts the banner off, opens POL-01 at the provider and confirms it; it moves to Done', async ({ page, baseURL }) => {
    const asked = await askDomainOwners(page, baseURL);
    expect(asked.message[0]).toMatch(/^Asked \d+ (person|people) to confirm POL-01 version 4\.0$/);

    await signIn(page, baseURL, 'bagus');
    await openApp(page);
    await expect(banner(page)).toHaveAttribute('data-confirmation-banner', '1');
    await expect(banner(page)).toContainText('You have 1 policy to confirm');
    await button(banner(page), 'Later').click();
    await expect(banner(page)).toHaveCount(0);

    await expect(ui.nav(page, 'Policies to confirm')).toContainText('1');
    await ui.nav(page, 'Policies to confirm').click();
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await page.goto('/my-confirmations?ms=isms');
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await expect(body(page)).toBeVisible();
    const item = body(page).locator('[data-confirmation="POL-01"]');
    await expect(item).toContainText('Information Security Policy');
    await expect(item).toContainText('Version 4.0');
    await expect(item).toContainText('Confirm by 13 Oct 2026');
    await expect(item).toContainText('Not opened yet');
    await expect(button(item, 'Confirm')).toBeDisabled();
    await expect(item.getByRole('checkbox')).toBeDisabled();
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    const opened = page.waitForResponse((r) => /\/api\/v1\/me\/acknowledgements\/[^/]+\/open$/.test(r.url()));
    const popup = page.waitForEvent('popup');
    await button(item, 'Open document').click();
    const answer = await opened;
    expect(answer.status()).toBe(200);
    const { url } = await answer.json();
    expect(url).toMatch(/^https?:\/\//);
    expect(url).not.toContain('/api/v1/');
    await (await popup).close();
    await expect(item).toContainText(/Opened on \d{2} [A-Z][a-z]{2} 2026/);
    await expect(button(item, 'Open again')).toBeVisible();
    await item.getByLabel('I have read and understood this document').check();
    await button(item, 'Confirm').click();
    await expectToast(page, 'You confirmed POL-01 version 4.0');
    await expect(body(page)).toContainText('Nothing to confirm');
    await expect(body(page).locator('tbody tr', { hasText: 'POL-01' }).first()).toContainText(/Confirmed on \d{2} [A-Z][a-z]{2} 2026/);
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    await go(page, 'Overview');
    await expect(banner(page)).toHaveCount(0);
    const mine = await (await page.request.get(`${baseURL}/api/v1/me/acknowledgements`)).json();
    const list = Array.isArray(mine) ? mine : mine.items;
    expect(list.find((m) => m.document.code === 'POL-01')).toMatchObject({ status: 'confirmed', versionLabel: '4.0' });
  });

  test('a person who is not asked has nothing to confirm and sees no banner', async ({ page, baseURL }) => {
    await askDomainOwners(page, baseURL);
    await signIn(page, baseURL, 'hendra');
    await openApp(page);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(ui.nav(page, 'Policies to confirm')).toBeVisible();
    await expect(ui.nav(page, 'Policies to confirm')).not.toContainText(/\d/);
    await page.goto('/my-confirmations?ms=isms');
    await expect(ui.title(page)).toHaveText('Policies to confirm');
    await expect(body(page)).toContainText('Nothing to confirm');
    await expect(body(page).locator('[data-confirmation]')).toHaveCount(0);
  });
});
