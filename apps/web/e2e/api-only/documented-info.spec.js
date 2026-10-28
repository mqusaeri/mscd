import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, listRow, expectToast, expectOverlayReadable, expectReadableText } from '../helpers.js';

// Required documented information against the api (MILESTONE-2 M2-12, D.1 `documented-info.list` and
// `documented-info.link`, BR-40). The demo ISMS keeps no document with the pack code PLN-01 (risk treatment plan), so
// phase board activity 4.9 that expects it is refused (BR-40). rina registers the plan under her own code RTP-001 and
// links it to PLN-01 with "Link existing document"; the row then shows RTP-001 as linked, the badge counts one item
// less, and activity 4.9 can be completed. The demo seed holds a policy document in every system, so the activity that
// expects the policy code is already complete there; the risk treatment plan is the open activity of the seed whose
// pack code has no document. The template code PRC-04 (risk assessment method, expected by activity 4.1) is named only
// by records to retain; their rows link it too, and after a new page load the row still shows the link, read from the
// snapshot activity that expects the code.
const main = (page) => page.locator('main');
const scope = (page) => main(page).locator('[data-scope]');
const row = (page, code) => main(page).locator('tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp(`^${code}$`) }) });
const dialog = (page) => ui.modal(page).last();
const button = (scopeEl, name) => scopeEl.locator('button', { hasText: new RegExp(`^${name}$`) });
const badge = async (page) => Number((await ui.nav(page, 'Required documented information').innerText()).replace(/\D+/g, '') || 0);

async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, {
    method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function activityTransition(page, baseURL, ms, no, to) {
  const snap = await (await page.request.get(`${baseURL}/api/v1/ui/ms/${ms}`)).json();
  const ref = snap.refs[`${ms}:act:${no}`];
  expect(ref, `activity ${no} of ${ms}`).toBeTruthy();
  return apiWrite(page, baseURL, 'POST', `/api/v1/ms/${ms}/activities/${ref.id}/transitions`, { to });
}

test.describe('Required documented information against the api @api-only', () => {
  test('lists the documented information of the ISMS with the scope panel and the badge', async ({ page }) => {
    await openApp(page);
    await go(page, 'Required documented information');
    await expect(main(page).locator('.mx-card-title').first()).toHaveText('Scope');
    await expect(main(page)).toContainText('Clause 4, Context of the organisation');
    await expect(row(page, 'DI-02')).toContainText('POL-01');
    await expect(row(page, 'DI-02')).toContainText('Approved');
    await expect(row(page, 'DI-06')).toContainText('Missing');
    await expect(scope(page)).toContainText('No approved scope statement');
    const missing = await main(page).locator('tbody tr', { hasText: 'Missing' }).count();
    await expect.poll(() => badge(page)).toBe(missing);
    await main(page).getByText('Missing only').click();
    await expect(main(page).locator('tbody tr')).toHaveCount(missing);
    await expectReadableText(page, 4.5);
  });

  test('a document under the customer\'s own code is linked to the pack code, and the activity that expects it can be completed (BR-40)', async ({ page, baseURL }) => {
    expect((await activityTransition(page, baseURL, 'isms', '4.9', 'in_progress')).status).toBe(200);
    const before = await activityTransition(page, baseURL, 'isms', '4.9', 'complete');
    expect(before.status, JSON.stringify(before.body)).toBe(422);
    expect(before.body.rule).toBe('BR-40');

    await openApp(page);
    await go(page, 'Document register');
    await ui.pageAction(page, 'New document').click();
    const form = ui.drawer(page);
    await form.getByLabel(/^Document code/).fill('RTP-001');
    await form.getByLabel(/^Title/).fill('Risk treatment plan 2026');
    await form.getByLabel(/^Document type/).selectOption('plan');
    await form.getByLabel(/^Owner/).selectOption('rina');
    await button(form, 'Register document').click();
    await expectToast(page, 'RTP-001 registered as a draft');
    await expect(listRow(page, 'RTP-001')).toContainText('Draft');

    await go(page, 'Required documented information');
    await expect(row(page, 'DI-06')).toContainText('Missing');
    const missing = await badge(page);
    await row(page, 'DI-06').locator('button', { hasText: 'Link existing document' }).click();
    await expect(dialog(page)).toContainText('Link a document to PLN-01');
    await dialog(page).locator('input[type="search"]').fill('RTP');
    await dialog(page).locator('[role="option"]', { hasText: 'RTP-001' }).click();
    await expectOverlayReadable(page);
    await button(dialog(page), 'Link document').click();
    await expectToast(page, 'RTP-001 now stands for PLN-01');
    await expect(row(page, 'DI-06')).toContainText('RTP-001');
    await expect(row(page, 'DI-06')).toContainText('Linked to PLN-01');
    await expect(row(page, 'DI-06')).toContainText('Draft');
    await expect.poll(() => badge(page)).toBe(missing - 1);

    const after = await activityTransition(page, baseURL, 'isms', '4.9', 'complete');
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  });

  test('Remove link asks first and the row is missing again', async ({ page }) => {
    await openApp(page);
    await go(page, 'Required documented information');
    await row(page, 'DI-06').locator('button', { hasText: 'Link existing document' }).click();
    await dialog(page).locator('input[type="search"]').fill('PLN-02');
    await dialog(page).locator('[role="option"]', { hasText: 'PLN-02' }).click();
    await button(dialog(page), 'Link document').click();
    await expectToast(page, 'PLN-02 now stands for PLN-01');
    await row(page, 'DI-06').locator('button', { hasText: 'Remove link' }).click();
    await expect(dialog(page)).toContainText('PLN-02 no longer stands for PLN-01.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Remove link').click();
    await expectToast(page, 'The link of PLN-01 was removed');
    await expect(row(page, 'DI-06')).toContainText('Missing');
  });

  test('a record to retain links its template code PRC-04, and the link stays shown after a new page load (BR-40)', async ({ page }) => {
    await openApp(page);
    await go(page, 'Required documented information');
    await expect(row(page, 'DI-03')).toContainText('Record to retain');
    await expect(row(page, 'DI-03').locator('[data-template-doc]')).toHaveCount(0);
    // No activity expects REG-01 and no document to maintain names it: a link could not be shown after a new page load.
    await expect(row(page, 'DI-07').locator('button', { hasText: /link/i })).toHaveCount(0);
    await row(page, 'DI-03').locator('button', { hasText: 'Link existing document' }).click();
    await expect(dialog(page)).toContainText('Link a document to PRC-04');
    await dialog(page).locator('input[type="search"]').fill('PLN-02');
    await dialog(page).locator('[role="option"]', { hasText: 'PLN-02' }).click();
    await button(dialog(page), 'Link document').click();
    await expectToast(page, 'PLN-02 now stands for PRC-04');
    const linked = async () => {
      for (const code of ['DI-03', 'DI-04']) {
        await expect(row(page, code).locator('[data-template-doc]')).toContainText('PLN-02');
        await expect(row(page, code)).toContainText('Linked to PRC-04');
        await expect(row(page, code).locator('button', { hasText: /link/i })).toHaveText(['Change link', 'Remove link']);
      }
    };
    await linked();
    // A new page load forgets what this browser linked; the snapshot activity 4.1 that expects PRC-04 still shows it.
    await openApp(page);
    await go(page, 'Required documented information');
    await linked();
    await row(page, 'DI-03').locator('button', { hasText: 'Remove link' }).click();
    await button(dialog(page), 'Remove link').click();
    await expectToast(page, 'The link of PRC-04 was removed');
    await expect(row(page, 'DI-03').locator('[data-template-doc]')).toHaveCount(0);
    await expect(row(page, 'DI-03').locator('button', { hasText: 'Link existing document' })).toBeVisible();
  });

  test('the screen and its dialogs are readable in the dark theme', async ({ page }) => {
    await openApp(page, '?theme=dark');
    await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
    await go(page, 'Required documented information');
    await expect(row(page, 'DI-06')).toBeVisible();
    await expectReadableText(page, 4.5);
    await row(page, 'DI-06').locator('button', { hasText: 'Link existing document' }).click();
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');
    await button(scope(page), 'Register from template').click();
    await expectOverlayReadable(page);
  });
});
