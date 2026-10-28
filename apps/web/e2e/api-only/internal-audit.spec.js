import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, expectToast, expectOverlayReadable } from '../helpers.js';

// Internal audit against the api (MILESTONE-2 M2-14, D.2, M2-05). In PT Nusantara Digital Teknologi rina is the MS
// Manager of the ISMS, maya its Internal Auditor (`internal_audit.manage`) and hendra Top Management. The ISMS has a
// certified cycle and no internal audit yet; the framework packs hold no activity templates of type internal_audit
// (E.2), so "Generate from templates" adds none.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const audits = (page) => page.locator('main tr[data-hov]');

async function signIn(page, baseURL, handle, org = 'ndt') {
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID() } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json().catch(() => null);
}

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function plan(page, label, date) {
  await ui.pageAction(page, 'Plan internal audit').click();
  await expect(dialog(page)).toContainText('Plan an internal audit');
  await dialog(page).locator('input[name="name"]').fill(`Internal audit ${label}`);
  await dialog(page).locator('input[name="shortLabel"]').fill(label);
  await dialog(page).locator('input[name="scheduledAt"]').fill(date);
  await dialog(page).locator('input[name="auditDays"]').fill('2');
  await dialog(page).locator('select[name="lead"]').selectOption('maya');
  await dialog(page).locator('textarea[name="scopeText"]').fill('Clauses 4 to 10 and Annex A themes 5 and 8, Jakarta office');
}

test.describe('Internal audit against the api @api-only', () => {
  test('maya plans an internal audit, attaches a registered record as its report, records the outcome and raises a finding', async ({ page, baseURL }) => {
    // The report is a registered document of type record of the ISMS (D.2); the MS Manager registers it.
    await apiWrite(page, baseURL, 'POST', '/api/v1/ms/isms/documents', {
      docCode: 'REC-IA-2026', title: 'Internal audit report 2026', docType: 'record', ownerHandle: 'maya', classification: 'internal', orgWide: false, linkedMs: ['isms'],
    });
    await signIn(page, baseURL, 'maya');
    await openApp(page);
    await go(page, 'Internal audit');
    await expect(page.locator('main')).toContainText('No internal audit in this cycle yet');
    await expect(page.locator('main [data-coverage]')).toHaveText(/^0 of \d+ covered$/);
    await plan(page, 'IA 2026', '2026-10-12');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Plan internal audit').click();
    await expectToast(page, 'Internal audit IA 2026 planned');
    await expect(audits(page).filter({ hasText: 'IA 2026' })).toContainText('Not attached');
    await expect(drawer(page)).toContainText('IA 2026: Internal audit IA 2026');
    await expect(drawer(page)).toContainText('Maya Putri');
    await expect(drawer(page)).toContainText('Clauses 4 to 10 and Annex A themes 5 and 8, Jakarta office');
    await button(drawer(page), 'Generate from templates').click();
    await expectToast(page, 'The framework pack of this system has no activity templates for internal audits yet, so no activity was created.');
    await expect(drawer(page)).toContainText('No activities yet.');
    await inBothThemes(page, () => expectOverlayReadable(page));

    await button(drawer(page), 'Attach report').click();
    await expect(dialog(page)).toContainText('Attach the audit report');
    // An Internal Auditor does not register documents, so only the registered records are offered.
    await expect(dialog(page)).not.toContainText('A new record from a file');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="record"]').selectOption({ label: 'REC-IA-2026 Internal audit report 2026' });
    await button(dialog(page), 'Attach').click();
    await expectToast(page, 'Report REC-IA-2026 attached to IA 2026');
    await expect(drawer(page)).toContainText('REC-IA-2026 Internal audit report 2026');
    await expect(audits(page).filter({ hasText: 'IA 2026' })).toContainText('REC-IA-2026');

    await button(drawer(page), 'Record outcome summary').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="outcomeSummary"]').fill('One minor nonconformity on log reviews; the scope was covered.');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Outcome summary of IA 2026 saved');
    await expect(drawer(page)).toContainText('One minor nonconformity on log reviews; the scope was covered.');

    await button(drawer(page), 'Raise finding').click();
    await expect(dialog(page).locator('select[name="source"]')).toHaveValue('internal_audit');
    await expect(dialog(page).locator('select[name="auditEventId"] option:checked')).toContainText('IA 2026');
    await inBothThemes(page, () => expectOverlayReadable(page));
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    await dialog(page).locator('textarea[name="title"]').fill('Log reviews not recorded for the SIEM');
    await dialog(page).locator('select[name="classification"]').selectOption('minor');
    await dialog(page).locator('select[name="targetCode"]').selectOption('A.8.15');
    await dialog(page).locator('select').filter({ has: page.locator('option', { hasText: 'Bagus Prasetyo' }) }).first().selectOption('bagus');
    await button(dialog(page), 'Raise finding').click();
    await expectToast(page, `Finding ${code} raised`);
    await expect(drawer(page)).toContainText(code);
    await expect(drawer(page)).toContainText('Log reviews not recorded for the SIEM');
  });

  test('rina attaches the report as a new record with its file from the SharePoint picker', async ({ page }) => {
    await openApp(page);
    await go(page, 'Internal audit');
    await plan(page, 'IA 2026 B', '2026-10-19');
    await button(dialog(page), 'Plan internal audit').click();
    await expectToast(page, 'Internal audit IA 2026 B planned');
    await expect(drawer(page)).toContainText('IA 2026 B');
    await button(drawer(page), 'Attach report').click();
    await dialog(page).locator('label', { hasText: 'A new record from a file' }).click();
    await expect(dialog(page).locator('input[name="docCode"]')).toHaveValue('REC-IA-2026-B');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Choose file and attach').click();
    await expect(dialog(page)).toContainText('Compliance / ISMS / Documents');
    await dialog(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Report REC-IA-2026-B attached to IA 2026 B');
    await expect(drawer(page)).toContainText('REC-IA-2026-B IA 2026 B report');
    await go(page, 'Document register');
    await expect(page.locator('main')).toContainText('REC-IA-2026-B');
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('reads the programme without planning internal audits', async ({ page }) => {
      await openApp(page);
      await go(page, 'Internal audit');
      await expect(page.locator('main')).toContainText('Audit programme coverage');
      await expect(ui.pageAction(page, 'Plan internal audit')).toHaveCount(0);
    });
  });
});
