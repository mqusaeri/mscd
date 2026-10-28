import {
  test, expect, ui, openScreen, openApp, go, openRow, search, chip, metaById, expectToast, expectOverlayReadable, expectReadableText,
  expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Findings and actions of the sample build (MILESTONE-2 M2-14): the finding register with its filters, "Raise finding"
// with the clause or control it concerns (the open findings show on that control in Controls & requirements), the
// moves of a finding with the BR-06, BR-07 and BR-08 messages, corrective actions with their steps and the
// effectiveness check by another person (BR-09), and the self-assessment with "Raise finding" from a gap.
// @sample-only: the API project covers the screen in e2e/api-only/findings.spec.js.
const meta = metaById('findings');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const rows = (page) => page.locator('main tr[data-hov]');
const row = (page, text) => rows(page).filter({ hasText: text });
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: name });

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

/** Opens the close dialog of the finding in the drawer, confirms it and returns the dialog's text. */
async function tryClose(page) {
  await button(drawer(page), 'Close finding').click();
  await button(dialog(page), 'Close finding').click();
}

test.describe('Findings and actions @sample-only', () => {
  test('lists the open findings with their clause or control, filters them, and shows the counts on the tabs', async ({ page }) => {
    await openScreen(page, meta);
    await expect(tab(page, 'Findings')).toContainText('3');
    await expect(page.locator('main')).toContainText('3 open, 1 major');
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, 'IA-2026-02')).toContainText('A.5.18');
    await expect(row(page, 'IA-2026-01')).toContainText('Major nonconformity');
    await expect(row(page, 'NC-2025-02')).toContainText('Certification audit');
    await page.locator('main select[name="classification"]').selectOption('major');
    await expect(rows(page)).toHaveCount(1);
    await page.locator('main select[name="classification"]').selectOption('');
    await page.locator('main select[name="status"]').selectOption('all');
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('main')).toContainText('5 of 5 findings');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('raises a finding on a control; Controls & requirements shows it on that control and links back', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Raise finding').click();
    await expect(dialog(page)).toContainText('Raise a finding');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('IA-2026-03');
    await button(dialog(page), 'Raise finding').click();
    await expect(dialog(page)).toContainText('Required.');
    await dialog(page).locator('select[name="source"]').selectOption('other');
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('F-2026-01');
    await dialog(page).locator('textarea[name="title"]').fill('Log reviews not recorded for the SIEM');
    await dialog(page).locator('select[name="classification"]').selectOption('minor');
    await dialog(page).locator('select[name="targetCode"]').selectOption('A.8.15');
    await dialog(page).locator('select').filter({ has: page.locator('option', { hasText: 'Bagus Prasetyo' }) }).first().selectOption('bagus');
    await dialog(page).locator('input[name="dueAt"]').fill('2026-11-30');
    await button(dialog(page), 'Raise finding').click();
    await expectToast(page, 'Finding F-2026-01 raised');
    await expect(row(page, 'F-2026-01')).toContainText('A.8.15');
    await expect(row(page, 'F-2026-01')).toContainText('Bagus Prasetyo');

    await go(page, 'Controls & requirements');
    // A.8.15 is partly implemented, and the list opens on the implemented controls.
    await chip(page, 'All').click();
    await search(page, 'A.8.15');
    await openRow(page, 'A.8.15');
    const panel = drawer(page).locator('[data-findings-of="A.8.15"]');
    await expect(panel).toContainText('Open findings');
    await expect(panel).toContainText('F-2026-01');
    await expect(panel).toContainText('Log reviews not recorded for the SIEM');
    await panel.locator('button', { hasText: 'F-2026-01' }).click();
    await expect(page.locator('main h1')).toHaveText('Findings and actions');
    await expect(drawer(page)).toContainText('F-2026-01 Log reviews not recorded for the SIEM');

    await go(page, 'Controls & requirements');
    await chip(page, 'All').click();
    await search(page, 'A.5.1');
    await openRow(page, 'A.5.1');
    await expect(drawer(page).locator('[data-findings-of="A.5.1"]')).toContainText('No open findings for A.5.1.');
  });

  test('a major finding closes only with its root cause, systemic check and an effective corrective action (BR-06, BR-07, BR-08)', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'IA-2026-01').click();
    await expect(drawer(page)).toContainText('IA-2026-01 Risk treatment plan not approved by every risk owner');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await tryClose(page);
    await expect(dialog(page)).toContainText('A major finding cannot be closed without a root cause analysis.');
    await expect(dialog(page)).toContainText('BR-06');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await drawer(page).locator('textarea[name="rcaText"]').fill('The risk procedure has no approval step for risk owners');
    await button(drawer(page), 'Save texts').click();
    await expectToast(page, 'Root cause and systemic check saved');
    await tryClose(page);
    await expect(dialog(page)).toContainText('A major finding cannot be closed without a systemic check.');
    await page.keyboard.press('Escape');
    await drawer(page).locator('textarea[name="systemicCheckText"]').fill('Checked the risk registers of every system');
    await button(drawer(page), 'Save texts').click();
    await tryClose(page);
    await expect(dialog(page)).toContainText('The finding needs a closed and effective corrective action');
    await expect(dialog(page)).toContainText('BR-08');
    await page.keyboard.press('Escape');
    await button(drawer(page), 'Start work').click();
    await expectToast(page, 'Work on finding IA-2026-01 started');
    await expect(row(page, 'IA-2026-01')).toContainText('In progress');
  });

  test('checks the effectiveness of a corrective action; its nonconformity then closes', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Corrective actions').click();
    await row(page, 'CA-2025-02').click();
    await expect(drawer(page)).toContainText('Implemented');
    await expect(drawer(page)).toContainText('Bagus Prasetyo on 30 Aug 2026');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Record effectiveness check').click();
    await expect(dialog(page)).toContainText('Effectiveness check of CA-2025-02');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="note"]').fill('No critical patch overdue since September');
    await button(dialog(page), 'Record effectiveness check').click();
    await expectToast(page, 'Effectiveness check of CA-2025-02 recorded');
    await expect(drawer(page)).toContainText('Rina Kusuma on 29 Sep 2026');
    await expect(drawer(page)).toContainText('This corrective action is finished.');
    await drawer(page).locator('button', { hasText: 'NC-2025-02' }).click();
    await expect(drawer(page)).toContainText('NC-2025-02 Remediation SLA missed');
    await tryClose(page);
    await expectToast(page, 'Finding NC-2025-02 closed');
    await expect(row(page, 'NC-2025-02')).toHaveCount(0);
  });

  test('creates a corrective action for a finding and records its steps; the implementer cannot check it (BR-09)', async ({ page }) => {
    await openScreen(page, meta);
    await row(page, 'IA-2026-02').click();
    await button(drawer(page), 'Create corrective action').click();
    await expect(dialog(page)).toContainText('Create a corrective action');
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('CA-2026-01');
    await expect(dialog(page).locator('label', { hasText: 'IA-2026-02' }).locator('input')).toBeChecked();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="title"]').fill('Quarterly access review with evidence');
    await dialog(page).locator('select').filter({ has: page.locator('option', { hasText: 'Bagus Prasetyo' }) }).first().selectOption('bagus');
    await button(dialog(page), 'Create corrective action').click();
    await expectToast(page, 'Corrective action CA-2026-01 created');
    await expect(drawer(page)).toContainText('CA-2026-01 Quarterly access review with evidence');
    await button(drawer(page), 'Complete step').click();
    await expect(drawer(page)).toContainText('Write the text of this step.');
    for (const [step, text] of [['Correction', 'Completed the two missing reviews'], ['Root cause analysis', 'The review was not scheduled'], ['Systemic check', 'Checked every in-scope system'], ['Action', 'Quarterly review in the IT calendar']]) {
      await drawer(page).locator('textarea[name="stepText"]').fill(text);
      await button(drawer(page), 'Complete step').click();
      await expectToast(page, `${step} recorded for CA-2026-01`);
    }
    await expect(drawer(page)).toContainText('Quarterly review in the IT calendar');
    await expect(button(drawer(page), 'Record effectiveness check')).toBeDisabled();
    await expect(drawer(page)).toContainText('You implemented this action, so another person checks its effectiveness (BR-09).');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(drawer(page), 'Edit').click();
    await expect(dialog(page)).toContainText('Edit corrective action CA-2026-01');
    await dialog(page).locator('input[name="dueAt"]').fill('2026-12-15');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Corrective action CA-2026-01 saved');
    await expect(row(page, 'CA-2026-01')).toContainText('15 Dec 2026');
  });

  test('assesses a finding condition as a gap and raises a finding from it', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'Self-assessment').click();
    const fc03 = page.locator('main tr').filter({ hasText: 'FC-03' });
    await expect(fc03).toContainText('Not assessed');
    await expectReadableText(page, 4.5);
    await button(fc03, 'Assess').click();
    await expect(dialog(page)).toContainText('Assess condition FC-03');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('label', { hasText: /^Gap$/ }).click();
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('A gap needs an owner.');
    await expect(dialog(page)).toContainText('A gap needs a target date.');
    await dialog(page).locator('select').first().selectOption('rina');
    await dialog(page).locator('input[name="targetFixAt"]').fill('2026-11-30');
    await dialog(page).locator('textarea[name="note"]').fill('Three controls lack a risk-based reason');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Assessment of FC-03 saved');
    await expect(fc03).toContainText('Gap');
    await button(fc03, 'Raise finding').click();
    await expect(dialog(page)).toContainText('Raise a finding from gap FC-03');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Raise finding').click();
    await expectToast(page, 'Finding raised from gap FC-03');
    await expect(fc03).toContainText('SA-2026-01');
    await expect(button(fc03, 'Raise finding')).toHaveCount(0);
    await tab(page, 'Findings').click();
    await expect(row(page, 'SA-2026-01')).toContainText('Self-assessment');
  });

  test('the Internal Auditor raises findings without managing them; Top Management only reads', async ({ page }) => {
    await page.goto('/?screen=findings&persona=auditor');
    await expect(page.locator('main h1')).toHaveText('Findings and actions');
    await expect(ui.pageAction(page, 'Raise finding')).toBeVisible();
    await row(page, 'IA-2026-01').click();
    await expect(drawer(page).locator('button', { hasText: 'Close finding' })).toHaveCount(0);
    await expect(drawer(page).locator('textarea[name="rcaText"]')).toBeDisabled();
    await page.goto('/?screen=findings&persona=top');
    await expect(page.locator('main h1')).toHaveText('Findings and actions');
    await expect(ui.pageAction(page, 'Raise finding')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`the tabs, drawers and forms are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(page.locator('main')).toContainText('3 terbuka, 1 mayor');
      await expectReadableText(page, 4.5);
      await row(page, 'IA-2026-01').click();
      await expect(drawer(page)).toContainText('Akar masalah dan pemeriksaan sistemik');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await tab(page, 'Tindakan korektif').click();
      await expectReadableText(page, 4.5);
      await row(page, 'CA-2025-02').click();
      await expect(drawer(page)).toContainText('Pemeriksaan efektivitas');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await tab(page, 'Penilaian mandiri').click();
      await expectReadableText(page, 4.5);
      await ui.pageAction(page, 'Catat temuan').click();
      await expect(dialog(page)).toContainText('Catat temuan');
      await expectOverlayReadable(page);
    });
  }
});

test.describe('Open findings on a clause or control @sample-only', () => {
  test('the requirement detail lists the open findings stored with the control code', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await openRow(page, 'A.5.18');
    const panel = drawer(page).locator('[data-findings-of="A.5.18"]');
    await expect(panel).toContainText('IA-2026-02');
    await expect(panel).toContainText('Access review records incomplete for two in-scope systems');
    await expectOverlayReadable(page);
  });
});
