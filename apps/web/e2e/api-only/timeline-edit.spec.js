import { randomUUID } from 'node:crypto';
import { test, expect, ui, go, openApp, switchMs, expectToast, expectOverlayReadable } from '../helpers.js';

// Certification timeline forms against the api (MILESTONE-2 M2-15, D.4, M2-05). rina is the MS Manager of every system of
// PT Nusantara Digital Teknologi; the demo date is 29 Sep 2026. The ISMS has a certified cycle (14 Mar 2025 to 14 Mar
// 2028) with its five audits, the BCMS a planned cycle with Stage 1 and Stage 2 in 2027, the ABMS a planned cycle and
// no audit event. ISO/IEC 27001 holds three audit activity templates for Stage 1 and three for Stage 2 (E.2).
const lanes = (page) => page.locator('main div[style*="height: 58px"]');
const lane = (page, short) => lanes(page).filter({ has: page.locator('span', { hasText: new RegExp('^' + short + '$') }) });
const marker = (page, title) => page.locator(`main button[title="${title}"]`);
const card = (page) => page.locator('main div[style*="flex-direction: column"][style*="gap: 14px"]').filter({ hasText: 'Audit event,' });
const panel = (page) => page.locator('main [data-tl-panel]');
const cyclePanel = (page) => panel(page).locator('[data-tl-cycle]');
const activities = (page) => panel(page).locator('[data-tl-activities]');
const prepRow = (page, title) => page.locator('main div[style*="grid-template-columns: 20px 1fr 170px 110px"]').filter({ hasText: title });
const cycleRow = (page, title) => page.locator('main div[style*="grid-template-columns: 20px 1fr auto"]').filter({ hasText: title });
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

/** A write of the api as the session's user, with its CSRF token. */
async function apiWrite(page, baseURL, method, url, data, headers = {}) {
  const me = await (await page.request.get(`${baseURL}/api/v1/me`)).json();
  const res = await page.request.fetch(`${baseURL}${url}`, { method, data, headers: { origin: baseURL, 'x-csrf-token': me.csrfToken, 'idempotency-key': randomUUID(), ...headers } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json().catch(() => null);
}

async function openTimeline(page) {
  await openApp(page);
  await go(page, 'Certification timeline');
  await expect(cyclePanel(page)).toBeVisible();
}

test.describe('Certification timeline forms against the api @api-only', () => {
  test('Add audit event from the empty ABMS lane activates its planned cycle', async ({ page }) => {
    await openTimeline(page);
    await lane(page, 'ABMS').locator('button', { hasText: 'Add audit event' }).click();
    await expect(dialog(page)).toContainText('Add audit event');
    await expect(dialog(page).locator('input[name="shortLabel"]')).toHaveValue('Stage 1');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Add audit event').click();
    await expect(dialog(page)).toContainText('Required.');
    await dialog(page).locator('input[name="scheduledAt"]').fill('2027-03-01');
    await dialog(page).locator('input[name="auditDays"]').fill('2');
    await dialog(page).locator('input[name="leadAuditor"]').fill('Dr. Lestari Wibowo');
    await button(dialog(page), 'Add audit event').click();
    await expectToast(page, 'Audit event Stage 1 added. The planned certification cycle is now active');
    await expect(dialog(page)).toHaveCount(0);
    await expect(marker(page, 'Stage 1, 1 Mar 2027')).toBeVisible();
    await switchMs(page, 'ABMS');
    await expect(card(page)).toContainText('Stage 1');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'active');
    await expect(ui.pageAction(page, 'Record certificate')).toBeVisible();
    await expect(ui.pageAction(page, 'Start certification cycle')).toHaveCount(0);
  });

  test('Edit names the BR-42 count; Record result shows on the audit card', async ({ page }) => {
    await openTimeline(page);
    await expect(card(page)).toContainText('Surveillance 1');
    await button(panel(page), 'Edit').click();
    await expect(dialog(page).locator('input[name="nameEn"]')).toHaveValue(/Surveillance/);
    await expect(dialog(page).locator('input[name="nameId"]')).toHaveValue(/surveilans/i);
    await expect(dialog(page).locator('input[name="prepWindowDays"]')).toHaveValue('60');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-10-20');
    await button(dialog(page), 'Save').click();
    await expectToast(page, /Audit event Surveillance 1 saved\. \d+ people were notified of items now due after the audit \(BR-42\)\./);
    await expect(marker(page, 'Surveillance 1, 20 Oct 2026')).toBeVisible();

    await marker(page, 'Stage 2, certification, 10 Mar 2025').click();
    await button(panel(page), 'Record result').click();
    await expect(dialog(page)).toContainText('Record audit result');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('select[name="outcome"]').selectOption('recommended');
    await dialog(page).locator('textarea[name="summary"]').fill('Certified, 2 minor nonconformities, 1 opportunity for improvement');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Result of Stage 2, certification recorded');
    await expect(card(page)).toContainText('Certified, 2 minor nonconformities, 1 opportunity for improvement');
    await expect(panel(page)).toContainText('Result: Recommended');
  });

  test('generates the Stage 1 activities from the pack and edits one', async ({ page }) => {
    await openTimeline(page);
    await marker(page, 'Stage 1, 20 Jan 2025').click();
    await expect(activities(page)).toContainText('No activities yet.');
    await button(activities(page), 'Generate activities').click();
    await expectToast(page, '3 audit activities created from the templates');
    await expect(activities(page).locator('[data-activity]')).toHaveCount(3);
    await activities(page).locator('[data-activity="AA-S1-01"] button', { hasText: 'Edit activity' }).click();
    await expect(dialog(page)).toContainText('Key questions');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).getByLabel('Auditee').selectOption('rina');
    await dialog(page).locator('select[name="status"]').selectOption('done');
    await dialog(page).locator('input[name="targetCode"]').fill('4.3');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Activity AA-S1-01 saved');
    await expect(activities(page).locator('[data-activity="AA-S1-01"]')).toContainText('Done');
    await expect(activities(page).locator('[data-activity="AA-S1-01"]')).toContainText('Clause 4.3, auditee Rina Kusuma');
  });

  test('reassigns a preparation task within BR-43 and marks tasks and cycle items done', async ({ page }) => {
    await openTimeline(page);
    const soa = prepRow(page, 'Approve SoA v3.0');
    await soa.locator('button', { hasText: 'Reassign or change due date' }).click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="due"]').fill('2026-11-20');
    await expect(dialog(page)).toContainText('BR-43: the task must be due before the audit on 12 Nov 2026.');
    await dialog(page).locator('input[name="due"]').fill('2026-11-01');
    await dialog(page).getByLabel('Holder').selectOption('rina');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Approve SoA v3.0 updated');
    await expect(soa).toContainText('Rina Kusuma');
    await expect(soa).toContainText('1 Nov 2026');
    // Not started: the task moves through in progress to done (C.13).
    await soa.locator('button', { hasText: 'Mark done' }).click();
    await expectToast(page, 'Approve SoA v3.0 marked done');
    await expect(soa.locator('span').first()).toHaveText('✓');
    await expect(soa.locator('button')).toHaveCount(0);
    const review = cycleRow(page, 'Management review with all mandatory inputs');
    await review.locator('button', { hasText: 'Mark done' }).click();
    await expectToast(page, 'Management review with all mandatory inputs marked done');
    await expect(review).toContainText('Done');
  });

  test('starts the BCMS cycle from the page action and records the certificate after a recommended Stage 2', async ({ page }) => {
    await openTimeline(page);
    await switchMs(page, 'BCMS');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'planned');
    await expect(ui.pageAction(page, 'Record certificate')).toHaveCount(0);
    await ui.pageAction(page, 'Start certification cycle').click();
    await expect(dialog(page)).toContainText('The planned cycle of this system starts with these dates.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="cycleStart"]').fill('2026-09-01');
    await button(dialog(page), 'Start certification cycle').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'active');
    await expect(ui.pageAction(page, 'Start certification cycle')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Record certificate')).toBeVisible();
    // An active cycle can be closed; the form is checked and left unsaved.
    await button(cyclePanel(page), 'Close cycle').click();
    await expect(dialog(page)).toContainText('Close cycle');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await marker(page, 'Stage 2, certification, 20 Apr 2027').click();
    await button(panel(page), 'Edit').click();
    await dialog(page).locator('input[name="scheduledAt"]').fill('2026-09-20');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Audit event Stage 2, certification saved');
    await marker(page, 'Stage 2, certification, 20 Sep 2026').click();
    await button(panel(page), 'Record result').click();
    await dialog(page).locator('select[name="outcome"]').selectOption('recommended');
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'Result of Stage 2, certification recorded');

    await ui.pageAction(page, 'Record certificate').click();
    await expect(dialog(page)).toContainText('Based on Stage 2, certification of 20 Sep 2026: Recommended.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('input[name="certificateNo"]').fill('BCMS-2026-0001');
    await dialog(page).locator('input[name="expiresAt"]').fill('2029-09-28');
    await button(dialog(page), 'Record certificate').click();
    await expectToast(page, 'Certificate BCMS-2026-0001 recorded. The system is certified until 28 Sep 2029.');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'certified');
    await expect(cyclePanel(page)).toContainText('BCMS-2026-0001');
    const cycles = await (await page.request.get('/api/v1/ms/bcms/certification-cycles')).json();
    expect(cycles[0]).toMatchObject({ status: 'certified', certificateNo: 'BCMS-2026-0001', certificateExpiresAt: '2029-09-28' });
  });

  test('a suspension saved with a stale ETag shows the conflict; the certificate is reinstated after it', async ({ page, baseURL }) => {
    await openTimeline(page);
    await expect(cyclePanel(page).locator('[data-tl-expires]')).toHaveText(/^13 Mar 2028, in \d+ days$/);
    // J.8: the server withdraws a suspended certificate only, so a certified cycle offers no withdrawal.
    await expect(button(cyclePanel(page), 'Record withdrawal')).toHaveCount(0);
    // No cycle is active, so the next cycle can start, from the panel as from the page action.
    await expect(button(cyclePanel(page), 'Start certification cycle')).toBeVisible();
    await expect(ui.pageAction(page, 'Start certification cycle')).toBeVisible();
    await button(cyclePanel(page), 'Record suspension').click();
    await inBothThemes(page, () => expectOverlayReadable(page));
    // Someone else records the suspension first, so the ETag the form holds is stale (R-18).
    const [cycle] = await (await page.request.get(`${baseURL}/api/v1/ms/isms/certification-cycles`)).json();
    await apiWrite(page, baseURL, 'POST', `/api/v1/ms/isms/certification-cycles/${cycle.id}/transitions`, { to: 'suspended', reason: 'Recorded by a colleague' });
    await dialog(page).locator('textarea[name="reason"]').fill('Suspended by PT Sertifikasi Nusantara after the surveillance audit');
    await button(dialog(page), 'Record suspension').click();
    await expect(dialog(page)).toContainText('Someone changed this record since you opened it.');
    // The latest cycle is already suspended, so Save stays off instead of sending a move J.8 refuses (409).
    await expect(dialog(page)).toContainText('This cycle is already suspended, so there is nothing more to record.');
    await expect(button(dialog(page), 'Record suspension')).toBeDisabled();
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'suspended');
    await expect(button(cyclePanel(page), 'Record withdrawal')).toBeVisible();
    // A suspended certificate waits for the certification body to reinstate or withdraw it: no new cycle yet, on the
    // panel as in the page header.
    await expect(button(cyclePanel(page), 'Start certification cycle')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Start certification cycle')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Record certificate')).toHaveCount(0);
    // The withdrawal form is checked and left unsaved.
    await button(cyclePanel(page), 'Record withdrawal').click();
    await expect(dialog(page)).toContainText('Record withdrawal');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await button(cyclePanel(page), 'Reinstate certificate').click();
    await expect(dialog(page)).toContainText('Reinstate certificate');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await dialog(page).locator('textarea[name="reason"]').fill('The certification body lifted the suspension');
    await button(dialog(page), 'Reinstate certificate').click();
    await expectToast(page, 'Certificate reinstated');
    await expect(cyclePanel(page)).toHaveAttribute('data-tl-cycle', 'certified');
    await expect(button(cyclePanel(page), 'Record withdrawal')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Start certification cycle')).toBeVisible();
  });
});

test.describe('Certification timeline for Top Management @api-only', () => {
  test.use({ apiSession: 'hendra' });

  test('hendra reads the cycle panel without actions and is told who adds audit events', async ({ page }) => {
    await openTimeline(page);
    await expect(cyclePanel(page)).toContainText('Certified');
    await expect(panel(page).locator('button')).toHaveCount(0);
    await expect(prepRow(page, 'Approve SoA v3.0').locator('button')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Start certification cycle')).toHaveCount(0);
    await expect(ui.pageAction(page, 'Record certificate')).toHaveCount(0);
    await ui.pageAction(page, 'Add audit event').click();
    await expectToast(page, 'Only the MS Manager of this system adds audit events.');
    await expect(dialog(page)).toHaveCount(0);
  });
});
