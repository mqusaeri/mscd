import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow, switchMs,
} from '../helpers.js';

// Internal audit of the sample build (MILESTONE-2 M2-14): the internal audits of the certification cycle with their
// report, the programme coverage of clauses 4 to 10 and the applicable controls, "Plan internal audit", the audit
// drawer with "Generate from templates", "Edit activity" and the AUD-INDEP warning, "Attach report" from a new record
// and its file, "Record outcome summary" and "Raise finding" prefilled with the audit. @sample-only: the API project
// covers the screen in e2e/api-only/internal-audit.spec.js.
const meta = metaById('internal-audit');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const audits = (page) => page.locator('main tr[data-hov]');
const activity = (page, code) => drawer(page).locator(`[data-activity="${code}"]`);

// The header sits under the backdrop of an open drawer or form, so the check switches the theme attribute of the app
// root itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Internal audit @sample-only', () => {
  test('lists the internal audits of the cycle and the programme coverage, with a filter for what is not covered', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main).toContainText('Certification cycle: 14 Mar 2025 to 13 Mar 2028, certified');
    await expect(audits(page)).toHaveCount(2);
    await expect(audits(page).nth(0)).toContainText('IA 2025');
    await expect(audits(page).nth(0)).toContainText('REC-IA-2025');
    await expect(audits(page).nth(1)).toContainText('IA 2026');
    await expect(audits(page).nth(1)).toContainText('Not attached');
    const coverage = main.locator('[data-coverage]');
    await expect(coverage).toHaveText(/^\d+ of \d+ covered$/);
    const rows = main.locator('table').nth(1).locator('tbody tr');
    await expect(rows.filter({ hasText: 'Management review inputs' })).toContainText('Covered');
    await expect(rows.filter({ hasText: 'Operational planning and control' })).toContainText('Not covered');
    await main.locator('select[name="coverage"]').selectOption('uncovered');
    await expect(rows.filter({ hasText: /^Covered/ })).toHaveCount(0);
    await expect(rows.first()).toContainText('Not covered');
    await main.locator('select[name="coverage"]').selectOption('control');
    await expect(rows.first()).toContainText('Control');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('plans an internal audit, generates its activities and warns when an auditor would audit their own work', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Plan internal audit').click();
    await expect(dialog(page)).toContainText('Plan an internal audit');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="shortLabel"]').fill('');
    await dialog(page).locator('input[name="name"]').fill('Internal audit of Annex A themes 7 and 8');
    await button(dialog(page), 'Plan internal audit').click();
    await expect(dialog(page)).toContainText('Required.');
    await dialog(page).locator('input[name="shortLabel"]').fill('IA 2026 B');
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-11-24');
    await dialog(page).locator('input[name="auditDays"]').fill('2');
    await dialog(page).locator('select[name="lead"]').selectOption('maya');
    await dialog(page).locator('textarea[name="scopeText"]').fill('Annex A themes 7 and 8, Surabaya site');
    await button(dialog(page), 'Plan internal audit').click();
    await expectToast(page, 'Internal audit IA 2026 B planned');
    await expect(audits(page)).toHaveCount(3);
    // The new audit opens in its drawer.
    await expect(drawer(page)).toContainText('IA 2026 B: Internal audit of Annex A themes 7 and 8');
    await expect(drawer(page)).toContainText('Maya Putri');
    await expect(drawer(page)).toContainText('No activities yet.');
    await button(drawer(page), 'Generate from templates').click();
    await expectToast(page, '8 audit activities created from the templates');
    await expect(drawer(page).locator('[data-activity]')).toHaveCount(8);
    await activity(page, 'IA-05').locator('button', { hasText: 'Edit activity' }).click();
    await expect(dialog(page)).toContainText('Edit activity IA-05');
    await expect(dialog(page)).toContainText('Do the sampled operations run as planned, with records that show it?');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="auditor"]').selectOption('bagus');
    await dialog(page).locator('select[name="targetCode"]').selectOption('A.8.8');
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-11-25');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Activity IA-05 saved. Bagus Prasetyo owns an entry, document or evidence of A.8.8.');
    await expect(drawer(page)).toContainText('AUD-INDEP');
    await expect(activity(page, 'IA-05')).toContainText('Clause or control A.8.8; auditor Bagus Prasetyo; planned 25 Nov 2026');
    await inBothThemes(page, () => expectOverlayReadable(page));
    // The programme now counts the controls the new audit covers.
    await page.keyboard.press('Escape');
    await page.locator('main select[name="coverage"]').selectOption('control');
    await expect(page.locator('main table').nth(1).locator('tbody tr').filter({ hasText: 'Management of technical vulnerabilities' })).toContainText('IA 2026 B');
  });

  test('attaches the report as a new record from a file, records the outcome and raises a finding of the audit', async ({ page }) => {
    await openScreen(page, meta);
    await audits(page).filter({ hasText: 'IA 2026' }).click();
    await expect(drawer(page)).toContainText('IA 2026: Internal audit 2026');
    await expect(drawer(page)).toContainText('IA-2026-01');
    await button(drawer(page), 'Attach report').click();
    await expect(dialog(page)).toContainText('Attach the audit report');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('label', { hasText: 'A new record from a file' }).click();
    await expect(dialog(page).locator('input[name="docCode"]')).toHaveValue('REC-IA-2026');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Choose file and attach').click();
    await expect(dialog(page)).toContainText('Compliance');
    await dialog(page).locator('button', { hasText: 'Link selected file' }).click();
    await expectToast(page, 'Report REC-IA-2026 attached to IA 2026');
    await expect(drawer(page)).toContainText('REC-IA-2026 IA 2026 report');
    await expect(audits(page).filter({ hasText: 'IA 2026' })).toContainText('REC-IA-2026');

    await button(drawer(page), 'Record outcome summary').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="outcomeSummary"]').fill('One major and one minor nonconformity; the risk owners need training.');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Outcome summary of IA 2026 saved');
    await expect(drawer(page)).toContainText('One major and one minor nonconformity; the risk owners need training.');

    await button(drawer(page), 'Raise finding').click();
    await expect(dialog(page)).toContainText('Raise a finding');
    await expect(dialog(page).locator('select[name="source"]')).toHaveValue('internal_audit');
    await expect(dialog(page).locator('select[name="auditEventId"] option:checked')).toContainText('IA 2026');
    await expect(dialog(page).locator('input[name="code"]')).toHaveValue('IA-2026-03');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="title"]').fill('Log reviews not recorded for the SIEM');
    await dialog(page).locator('select[name="classification"]').selectOption('minor');
    await dialog(page).locator('select[name="targetCode"]').selectOption('A.8.15');
    await dialog(page).locator('select').filter({ has: page.locator('option', { hasText: 'Bagus Prasetyo' }) }).first().selectOption('bagus');
    await button(dialog(page), 'Raise finding').click();
    await expectToast(page, 'Finding IA-2026-03 raised');
    await expect(drawer(page)).toContainText('Log reviews not recorded for the SIEM');
  });

  test('the Internal Auditor plans and runs internal audits; Top Management reads them', async ({ page }) => {
    await page.goto('/?screen=internal-audit&persona=auditor');
    await expect(page.locator('main h1')).toHaveText('Internal audit');
    await expect(ui.pageAction(page, 'Plan internal audit')).toBeVisible();
    await audits(page).filter({ hasText: 'IA 2025' }).click();
    await expect(button(drawer(page), 'Replace report')).toBeVisible();
    await expect(drawer(page).locator('button', { hasText: 'Edit activity' }).first()).toBeVisible();
    await page.goto('/?screen=internal-audit&persona=top');
    await expect(page.locator('main h1')).toHaveText('Internal audit');
    await expect(ui.pageAction(page, 'Plan internal audit')).toHaveCount(0);
    await audits(page).filter({ hasText: 'IA 2025' }).click();
    await expect(drawer(page)).toContainText('Internal audit report 2025');
    await expect(drawer(page).locator('button', { hasText: 'Edit activity' })).toHaveCount(0);
    await expect(drawer(page).locator('button', { hasText: 'Replace report' })).toHaveCount(0);
  });

  test('a system without a certification cycle explains where the cycle starts', async ({ page }) => {
    await openScreen(page, meta);
    await switchMs(page, 'ABMS');
    await expect(page.locator('main')).toContainText('No certification cycle yet');
    await expect(page.locator('main')).toContainText('The MS Manager starts the cycle on the Certification timeline');
    await expectReadableText(page, 4.5);
  });

  for (const theme of ['light', 'dark']) {
    test(`the screen, the drawer and the plan form are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(page.locator('main')).toContainText('Audit internal siklus ini');
      await expectReadableText(page, 4.5);
      await audits(page).filter({ hasText: 'IA 2026' }).click();
      await expect(drawer(page)).toContainText('Aktivitas audit');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await ui.pageAction(page, 'Rencanakan audit internal').click();
      await expect(dialog(page)).toContainText('Rencanakan audit internal');
      await expectOverlayReadable(page);
    });
  }
});
