import { test, expect, ui, go, openApp, openRow, search, chip, expectToast, expectOverlayReadable, pageSettled } from '../helpers.js';

// Findings and actions against the api (MILESTONE-2 M2-14). In PT Nusantara Digital Teknologi rina is the MS Manager
// of the ISMS, maya its Internal Auditor and hendra Top Management; the seed holds the ISMS findings NC-2025-02
// (minor), IA-2026-01 (major) and IA-2026-02 (minor), no corrective action, and the six finding conditions of
// ISO/IEC 27001 not assessed yet.
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main tr[data-hov]');
const row = (page, text) => rows(page).filter({ hasText: text });
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: name });
const owner = (scope) => scope.locator('select').filter({ has: scope.page().locator('option', { hasText: 'Bagus Prasetyo' }) }).first();

async function signIn(page, baseURL, handle, org = 'ndt') {
  // Requests of the open page still under way would meet the cleared cookies (a 401: "Sign-in required"); M2-21 runs
  // tests in parallel, where the last reloads of a step can still run here.
  await pageSettled(page);
  await page.context().clearCookies();
  const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle, org }, headers: { origin: baseURL } });
  expect(res.ok(), await res.text()).toBe(true);
}

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function tryClose(page) {
  await button(drawer(page), 'Close finding').click();
  await button(dialog(page), 'Close finding').click();
}

test.describe('Findings and actions against the api @api-only', () => {
  test('rina raises a finding on A.8.15, which shows on that control in Controls & requirements', async ({ page }) => {
    await openApp(page);
    await go(page, 'Findings and actions');
    await expect(row(page, 'IA-2026-01')).toContainText('Major nonconformity');
    await ui.pageAction(page, 'Raise finding').click();
    await expect(dialog(page)).toContainText('Raise a finding');
    await expect(dialog(page).locator('select[name="targetCode"] option[value="A.8.15"]')).toHaveCount(1);
    await inBothThemes(page, () => expectOverlayReadable(page));
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    expect(code).toMatch(/^IA-2026-\d{2}$/);
    await dialog(page).locator('textarea[name="title"]').fill('Log reviews not recorded for the SIEM');
    await dialog(page).locator('select[name="classification"]').selectOption('minor');
    await dialog(page).locator('select[name="targetCode"]').selectOption('A.8.15');
    await owner(dialog(page)).selectOption('bagus');
    await dialog(page).locator('input[name="dueAt"]').fill('2026-11-30');
    await button(dialog(page), 'Raise finding').click();
    await expectToast(page, `Finding ${code} raised`);
    await expect(row(page, code)).toContainText('A.8.15');
    await expect(row(page, code)).toContainText('Bagus Prasetyo');

    await go(page, 'Controls & requirements');
    // The list opens on the implemented controls; A.8.15 may be at another status.
    await chip(page, 'All').click();
    await search(page, 'A.8.15');
    await openRow(page, 'A.8.15');
    const panel = drawer(page).locator('[data-findings-of="A.8.15"]');
    await expect(panel).toContainText(code);
    await expect(panel).toContainText('Log reviews not recorded for the SIEM');
    await panel.locator('button', { hasText: code }).click();
    await expect(page.locator('main h1')).toHaveText('Findings and actions');
    await expect(drawer(page)).toContainText(`${code} Log reviews not recorded for the SIEM`);
  });

  test('a major finding shows BR-06, BR-07 and BR-08; its corrective action is never checked by its implementer (BR-09) nor on the day it was implemented (BR-08)', async ({ page, baseURL }) => {
    await openApp(page);
    await go(page, 'Findings and actions');
    await row(page, 'IA-2026-01').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await tryClose(page);
    await expect(dialog(page)).toContainText('A major finding cannot be closed without a root cause analysis.');
    await expect(dialog(page)).toContainText('BR-06');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await drawer(page).locator('textarea[name="rcaText"]').fill('The risk procedure has no approval step for risk owners');
    await button(drawer(page), 'Save texts').click();
    await expectToast(page, 'Root cause and systemic check saved');
    // The drawer reads the saved finding (and its version) again after the toast; Close uses that version (M2-21: on a
    // busy machine a click before the read ended met a stale version).
    await pageSettled(page);
    await tryClose(page);
    await expect(dialog(page)).toContainText('A major finding cannot be closed without a systemic check.');
    await page.keyboard.press('Escape');
    await drawer(page).locator('textarea[name="systemicCheckText"]').fill('Checked the risk registers of every system');
    await button(drawer(page), 'Save texts').click();
    await expectToast(page, 'Root cause and systemic check saved');
    // The drawer reads the saved finding (and its version) again after the toast; Close uses that version (M2-21: on a
    // busy machine a click before the read ended met a stale version).
    await pageSettled(page);
    await tryClose(page);
    await expect(dialog(page)).toContainText('The finding needs a closed and effective corrective action');
    await expect(dialog(page)).toContainText('BR-08');
    await page.keyboard.press('Escape');

    await button(drawer(page), 'Create corrective action').click();
    await expect(dialog(page)).toContainText('Create a corrective action');
    await inBothThemes(page, () => expectOverlayReadable(page));
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    expect(code).toMatch(/^CA-2026-\d{2}$/);
    await dialog(page).locator('input[name="title"]').fill('Add the risk owner approval to the risk procedure');
    await owner(dialog(page)).selectOption('bagus');
    await button(dialog(page), 'Create corrective action').click();
    await expectToast(page, `Corrective action ${code} created`);
    await expect(drawer(page)).toContainText(`${code} Add the risk owner approval to the risk procedure`);
    for (const [step, text] of [['Correction', 'Owners approved the open plans'], ['Root cause analysis', 'No approval step'], ['Systemic check', 'Every register checked'], ['Action', 'Approval step added to PRC-04']]) {
      await drawer(page).locator('textarea[name="stepText"]').fill(text);
      await button(drawer(page), 'Complete step').click();
      await expectToast(page, `${step} recorded for ${code}`);
    }
    await expect(button(drawer(page), 'Record effectiveness check')).toBeDisabled();
    await expect(drawer(page)).toContainText('You implemented this action, so another person checks its effectiveness (BR-09).');
    await inBothThemes(page, () => expectOverlayReadable(page));

    // The Internal Auditor checks it, on the same day as the implementation.
    await signIn(page, baseURL, 'maya');
    await openApp(page);
    await go(page, 'Findings and actions');
    await tab(page, 'Corrective actions').click();
    await row(page, code).click();
    await button(drawer(page), 'Record effectiveness check').click();
    await expect(dialog(page)).toContainText(`Effectiveness check of ${code}`);
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record effectiveness check').click();
    await expect(dialog(page)).toContainText('the effectiveness verification must be dated differently from the implementation');
    await expect(dialog(page)).toContainText('BR-08');
    // The Internal Auditor raises findings but does not manage them.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await tab(page, 'Findings').click();
    await row(page, 'IA-2026-02').click();
    await expect(drawer(page).locator('button', { hasText: 'Close finding' })).toHaveCount(0);
    await expect(ui.pageAction(page, 'Raise finding')).toBeVisible();
  });

  test('a finding condition assessed as a gap raises a self-assessment finding once', async ({ page }) => {
    await openApp(page);
    await go(page, 'Findings and actions');
    await tab(page, 'Self-assessment').click();
    const fc04 = page.locator('main tr').filter({ hasText: 'FC-04' });
    await expect(fc04).toContainText('Not assessed');
    await button(fc04, 'Assess').click();
    await expect(dialog(page)).toContainText('Assess condition FC-04');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('label', { hasText: /^Gap$/ }).click();
    await owner(dialog(page)).selectOption('bagus');
    await dialog(page).locator('input[name="targetFixAt"]').fill('2026-10-31');
    await dialog(page).locator('textarea[name="note"]').fill('PRC-07 and REG-03 are past their review date');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Assessment of FC-04 saved');
    await expect(fc04).toContainText('Gap');
    await expect(fc04).toContainText('Bagus Prasetyo');
    await button(fc04, 'Raise finding').click();
    await expect(dialog(page)).toContainText('Raise a finding from gap FC-04');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Raise finding').click();
    await expect(fc04).toContainText(/SA-2026-\d{2}/);
    await expect(button(fc04, 'Raise finding')).toHaveCount(0);
    const code = (await fc04.innerText()).match(/SA-2026-\d{2}/)[0];
    await tab(page, 'Findings').click();
    await expect(row(page, code)).toContainText('Self-assessment');
    await expect(row(page, code)).toContainText('Bagus Prasetyo');
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('reads the register without raising findings and without the owners of other people', async ({ page }) => {
      await openApp(page);
      await go(page, 'Findings and actions');
      await expect(row(page, 'IA-2026-01')).toBeVisible();
      await expect(ui.pageAction(page, 'Raise finding')).toHaveCount(0);
      await expect(row(page, 'IA-2026-01')).not.toContainText('Rina Kusuma');
      await row(page, 'IA-2026-01').click();
      await expect(drawer(page).locator('button', { hasText: 'Edit' })).toHaveCount(0);
      await inBothThemes(page, () => expectOverlayReadable(page));
    });
  });
});
