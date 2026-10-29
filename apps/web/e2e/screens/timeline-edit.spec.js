import {
  test, expect, ui, openApp, go, switchMs, switchRole, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// Certification timeline forms of the sample build (MILESTONE-2 M2-15): the panel below the audit event with the
// certification cycle, its certificate and expiry date, "Edit" (the BR-42 count in the toast) and "Record result",
// the audit activities of a certification audit ("Generate activities", "Edit activity"), "Mark done" and "Reassign or
// change due date" (BR-43) of preparation tasks and cycle items, "Start certification cycle", "Record certificate"
// after a recommended result, and the suspension, reinstatement and withdrawal of a certificate. "Add audit event"
// opens its form in the sample build too; the API project covers its Save in e2e/api-only/timeline-edit.spec.js.
// @sample-only.
const marker = (page, title) => page.locator(`main button[title="${title}"]`);
const card = (page) => page.locator('main div[style*="flex-direction: column"][style*="gap: 14px"]').filter({ hasText: 'Audit event,' });
const panel = (page) => page.locator('main [data-tl-panel]');
const cyclePanel = (page) => panel(page).locator('[data-tl-cycle]');
const activities = (page) => panel(page).locator('[data-tl-activities]');
const prepRow = (page, title) => page.locator('main div[style*="grid-template-columns: 20px 1fr 170px 110px"]').filter({ hasText: title });
const cycleRow = (page, title) => page.locator('main div[style*="grid-template-columns: 20px 1fr auto"]').filter({ hasText: title });
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

// The header sits under the backdrop of an open form, so the check switches the theme attribute of the app root
// itself (the tokens follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

async function openTimeline(page, query = '') {
  await openApp(page, query);
  await go(page, query.includes('lang=id') ? 'Linimasa sertifikasi' : 'Certification timeline');
  await expect(cyclePanel(page)).toBeVisible();
}

test.describe('Certification timeline forms @sample-only', () => {
  test('the event panel shows the certification cycle with the certificate and its expiry date, and Add audit event opens its form', async ({ page }) => {
    await openTimeline(page);
    await expect(card(page)).toContainText('Surveillance 1');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'certified');
    await expect(cyclePanel(page)).toContainText('Certification cycle');
    await expect(cyclePanel(page)).toContainText('14 Mar 2025 to 14 Mar 2028');
    await expect(cyclePanel(page).locator('[data-tl-expires]')).toHaveText(/^13 Mar 2028, in \d+ days$/);
    await expect(cyclePanel(page)).toContainText('PT Sertifikasi Nusantara');
    await expect(cyclePanel(page)).toContainText('Not recorded');
    await expect(button(cyclePanel(page), 'Record suspension')).toBeVisible();
    // J.8: a certified cycle is suspended before it can be withdrawn.
    await expect(button(cyclePanel(page), 'Record withdrawal')).toHaveCount(0);
    // A future audit offers Edit; its result is recorded once it has taken place.
    await expect(button(panel(page), 'Edit')).toBeVisible();
    await expect(button(panel(page), 'Record result')).toHaveCount(0);
    await expect(panel(page)).toContainText('Record the result once the audit has taken place.');
    await expect(activities(page)).toContainText('No activities yet.');
    await ui.pageAction(page, 'Add audit event').click();
    await expect(dialog(page)).toContainText('Add audit event');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('Record result shows on the audit card; Edit moves the date and names the BR-42 count', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Stage 2, certification, 10 Mar 2025').click();
    await expect(card(page)).toContainText('Completed');
    await button(panel(page), 'Record result').click();
    await expect(dialog(page)).toContainText('Record audit result');
    await expect(dialog(page).locator('select[name="outcome"]')).toBeVisible();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="outcome"]').selectOption('recommended');
    await dialog(page).locator('textarea[name="summary"]').fill('Certified, 2 minor nonconformities, 1 opportunity for improvement');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Result of Stage 2, certification recorded');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page)).toContainText('Certified, 2 minor nonconformities, 1 opportunity for improvement');
    await expect(panel(page)).toContainText('Result: Recommended');

    await marker(page, 'Surveillance 1, 12 Nov 2026').click();
    await button(panel(page), 'Edit').click();
    await expect(dialog(page)).toContainText('Edit audit event');
    await expect(dialog(page).locator('input[name="nameEn"]')).toHaveValue('Surveillance 1');
    await expect(dialog(page).locator('input[name="leadAuditor"]')).toHaveValue('Ir. Dwi Hartanto, IRCA LA');
    await expect(dialog(page).locator('input[name="prepWindowDays"]')).toHaveValue('60');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('Nothing changed.');
    await dialog(page).locator('input[name="auditDays"]').fill('0');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toContainText('Enter a whole number from 1 to 365.');
    await dialog(page).locator('input[name="auditDays"]').fill('3');
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-10-20');
    await button(dialog(page), 'Save').click();
    // Holders of open preparation tasks now due on or after the new date: Rina, Hendra and Bagus.
    await expectToast(page, 'Audit event Surveillance 1 saved. 3 people were notified of items now due after the audit (BR-42).');
    await expect(marker(page, 'Surveillance 1, 20 Oct 2026')).toBeVisible();
    await expect(card(page)).toContainText('20 Oct 2026, 3 Audit days');
  });

  test('generates the activities of the Stage 1 audit from the pack templates and edits one', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Stage 1, 20 Jan 2025').click();
    await expect(activities(page)).toContainText('No activities yet.');
    await button(activities(page), 'Generate activities').click();
    await expectToast(page, '3 audit activities created from the templates');
    await expect(activities(page).locator('[data-activity]')).toHaveCount(3);
    await expect(activities(page).locator('[data-activity="AA-S1-01"]')).toContainText('Review ISMS scope and context');
    await activities(page).locator('[data-activity="AA-S1-01"]').locator('button', { hasText: 'Edit activity' }).click();
    await expect(dialog(page)).toContainText('Edit activity AA-S1-01');
    await expect(dialog(page)).toContainText('Key questions');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Auditee').selectOption('rina');
    await dialog(page).locator('select[name="status"]').selectOption('done');
    await dialog(page).locator('input[name="targetCode"]').fill('4.3');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Activity AA-S1-01 saved');
    await expect(activities(page).locator('[data-activity="AA-S1-01"]')).toContainText('Done');
    await expect(activities(page).locator('[data-activity="AA-S1-01"]')).toContainText('auditee Rina Kusuma');
    await button(activities(page), 'Generate activities').click();
    await expectToast(page, 'Every template activity of this audit already exists.');
  });

  test('marks preparation tasks and cycle items done and reassigns a task within BR-43', async ({ page }) => {
    await openTimeline(page);
    const soa = prepRow(page, 'Approve SoA v3.0');
    await expect(soa.locator('button', { hasText: 'Mark done' })).toBeVisible();
    // A done task keeps the row of the design, without actions.
    await expect(prepRow(page, 'Internal audit 2026 report issued').locator('button')).toHaveCount(0);
    await soa.locator('button', { hasText: 'Reassign or change due date' }).click();
    await expect(dialog(page)).toContainText('Reassign or change due date');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="due"]').fill('2026-11-15');
    await expect(dialog(page)).toContainText('BR-43: the task must be due before the audit on 12 Nov 2026.');
    await button(dialog(page), 'Save').click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('input[name="due"]').fill('2026-11-01');
    await dialog(page).getByLabel('Holder').selectOption('rina');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Approve SoA v3.0 updated');
    await expect(soa).toContainText('Rina Kusuma');
    await expect(soa).toContainText('1 Nov 2026');
    await soa.locator('button', { hasText: 'Mark done' }).click();
    await expectToast(page, 'Approve SoA v3.0 marked done');
    await expect(soa.locator('span').first()).toHaveText('✓');
    await expect(soa.locator('button')).toHaveCount(0);

    const review = cycleRow(page, 'Management review with all mandatory inputs');
    await review.locator('button', { hasText: 'Mark done' }).click();
    await expectToast(page, 'Management review with all mandatory inputs marked done');
    await expect(review).toContainText('Done');
    await expect(cyclePanel(page)).toContainText('1 of 6');
  });

  test('starts the BCMS cycle and records the certificate after a recommended Stage 2 result', async ({ page }) => {
    await openTimeline(page);
    await switchMs(page, 'BCMS');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'planned');
    await button(cyclePanel(page), 'Start certification cycle').click();
    await expect(dialog(page)).toContainText('The planned cycle of this system starts with these dates.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="cycleStart"]').fill('2026-09-01');
    await button(dialog(page), 'Start certification cycle').click();
    await expectToast(page, 'Certification cycle started');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'active');
    await expect(cyclePanel(page)).toContainText('1 Sep 2026 to 1 Sep 2029');
    await expect(cyclePanel(page).locator('button', { hasText: 'Record certificate' })).toBeDisabled();
    await expect(cyclePanel(page)).toContainText('Record the result of the Stage 2 or recertification audit first');

    await marker(page, 'Stage 2, certification, 20 Apr 2027').click();
    await button(panel(page), 'Edit').click();
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-09-20');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Audit event Stage 2, certification saved');
    await marker(page, 'Stage 2, certification, 20 Sep 2026').click();
    await button(panel(page), 'Record result').click();
    await dialog(page).locator('select[name="outcome"]').selectOption('recommended_with_conditions');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Result of Stage 2, certification recorded');
    await button(cyclePanel(page), 'Record certificate').click();
    await expect(dialog(page)).toContainText('Based on Stage 2, certification of 20 Sep 2026: Recommended with conditions.');
    await expect(dialog(page).locator('input[name="certificationBody"]')).toHaveValue('PT Sertifikasi Nusantara');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Record certificate').click();
    await expect(dialog(page)).toContainText('Required.');
    await dialog(page).locator('input[name="certificateNo"]').fill('BCMS-2026-0001');
    await dialog(page).locator('input[name="expiresAt"]').fill('2026-09-01');
    await button(dialog(page), 'Record certificate').click();
    await expect(dialog(page)).toContainText('The expiry date must be after the issue date.');
    await dialog(page).locator('input[name="expiresAt"]').fill('2029-09-28');
    await button(dialog(page), 'Record certificate').click();
    await expectToast(page, 'Certificate BCMS-2026-0001 recorded. The system is certified until 28 Sep 2029.');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'certified');
    await expect(cyclePanel(page)).toContainText('BCMS-2026-0001');
  });

  test('records the suspension, reinstatement and withdrawal of the ISMS certificate with a reason', async ({ page }) => {
    await openTimeline(page);
    await button(cyclePanel(page), 'Record suspension').click();
    await expect(dialog(page)).toContainText('Record suspension');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('no');
    await button(dialog(page), 'Record suspension').click();
    await expect(dialog(page)).toContainText('Give a reason of at least 3 characters.');
    await dialog(page).locator('textarea[name="reason"]').fill('Suspended by PT Sertifikasi Nusantara after the surveillance audit');
    await button(dialog(page), 'Record suspension').click();
    await expectToast(page, 'Certificate suspended');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'suspended');
    await expect(cyclePanel(page)).toContainText('The certification body suspended this certificate.');
    await button(cyclePanel(page), 'Reinstate certificate').click();
    await expect(dialog(page)).toContainText('Reinstate certificate');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Suspension lifted');
    await button(dialog(page), 'Reinstate certificate').click();
    await expectToast(page, 'Certificate reinstated');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'certified');
    await expect(button(cyclePanel(page), 'Record withdrawal')).toHaveCount(0);
    // The certification body withdraws a suspended certificate: suspend again, then record the withdrawal.
    await button(cyclePanel(page), 'Record suspension').click();
    await dialog(page).locator('textarea[name="reason"]').fill('Suspended again after a follow-up visit');
    await button(dialog(page), 'Record suspension').click();
    await expectToast(page, 'Certificate suspended');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'suspended');
    await button(cyclePanel(page), 'Record withdrawal').click();
    await expect(dialog(page)).toContainText('Record withdrawal');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('Withdrawn by the certification body');
    await button(dialog(page), 'Record withdrawal').click();
    await expectToast(page, 'Certificate withdrawn');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'withdrawn');
    // A withdrawn certificate ends its cycle; the next certification cycle starts from the panel (D.4).
    await expect(cyclePanel(page).locator('button')).toHaveText(['Start certification cycle']);
    await button(cyclePanel(page), 'Start certification cycle').click();
    await expect(dialog(page)).toContainText('Start certification cycle');
    await button(dialog(page), 'Start certification cycle').click();
    await expectToast(page, 'Certification cycle started');
    await expect(dialog(page)).toHaveCount(0);
    // Surveillance 1 (12 Nov 2026) now falls in the new cycle, which starts on the sample date.
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'active');
    await expect(cyclePanel(page)).toContainText('29 Sep 2026 to 29 Sep 2029');
    await expect(button(cyclePanel(page), 'Start certification cycle')).toHaveCount(0);
    await button(cyclePanel(page), 'Close cycle').click();
    await expect(dialog(page)).toContainText('Close cycle');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('Top Management reads the panel without actions, and the panel speaks Indonesian', async ({ page }) => {
    await openTimeline(page);
    await switchRole(page, 'Top Management');
    await go(page, 'Certification timeline');
    await expect(cyclePanel(page)).toBeVisible();
    await expect(panel(page).locator('button')).toHaveCount(0);
    await expect(prepRow(page, 'Approve SoA v3.0').locator('button')).toHaveCount(0);

    await openTimeline(page, '?lang=id');
    await expect(cyclePanel(page)).toContainText('Siklus sertifikasi');
    await expect(cyclePanel(page)).toContainText('Tersertifikasi');
    await expect(button(panel(page), 'Ubah')).toBeVisible();
    await expect(prepRow(page, 'Approve SoA v3.0').locator('button', { hasText: 'Tandai selesai' })).toBeVisible();
    await button(panel(page), 'Ubah').click();
    await expect(dialog(page)).toContainText('Ubah event audit');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });
});
