import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// Pending approvals of the sample build (MILESTONE-2 M2-10): two role grants (Tono asks for Yusuf, a Storage Admin;
// Rina asks for herself) and two routing changes wait. The sample persona Rina decides on the ones she neither asked
// for nor receives; the sidebar badge follows the number left. @sample-only: the API project covers the screen in
// e2e/api-only/approvals.spec.js.
const meta = metaById('approvals');
const dialog = (page) => ui.modal(page);
const grantRows = (page) => page.locator('main [data-approvals="grants"] tbody tr');
const ruleRows = (page) => page.locator('main [data-approvals="rules"] tbody tr');
const badge = (page) => ui.nav(page, 'Pending approvals');

test.describe('Pending approvals @sample-only', () => {
  test('lists the waiting grants and routing changes with who asked, who can approve and the badge', async ({ page }) => {
    await openScreen(page, meta);
    await expect(badge(page)).toContainText('4');
    await expect(grantRows(page)).toHaveCount(2);
    await expect(grantRows(page).nth(0)).toContainText('Yusuf Rahman');
    await expect(grantRows(page).nth(0)).toContainText('Risk Owner, ISMS');
    await expect(grantRows(page).nth(0)).toContainText('Tono Hartono');
    await expect(grantRows(page).nth(0)).toContainText('Rina Kusuma');
    const own = grantRows(page).nth(1);
    await expect(own).toContainText('This grant is for you; another Tenant Admin decides on it.');
    await expect(own.locator('button', { hasText: 'Approve' })).toBeDisabled();
    await expect(ruleRows(page)).toHaveCount(2);
    await expect(ruleRows(page).filter({ hasText: 'ISMS' })).toContainText('You asked for this change; another Tenant Admin decides on it.');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('approve a grant and reject a routing change; the badge counts down and People and roles follows', async ({ page }) => {
    await openScreen(page, meta);
    await grantRows(page).nth(0).locator('button', { hasText: 'Approve' }).click();
    await expectToast(page, 'Risk Owner in ISMS for Yusuf Rahman approved');
    await expect(grantRows(page)).toHaveCount(1);
    await expect(badge(page)).toContainText('3');
    await ruleRows(page).filter({ hasText: 'BCMS' }).locator('button', { hasText: 'Reject' }).click();
    await expect(dialog(page)).toContainText('Reject this routing change');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Routing change rejected');
    await expect(ruleRows(page)).toHaveCount(1);
    await expect(badge(page)).toContainText('2');
    await ui.nav(page, 'People and roles').click();
    await expect(page.locator('main table tbody tr', { hasText: 'Yusuf Rahman' })).not.toContainText('waiting for approval');
  });

  test('reject a grant after the confirmation', async ({ page }) => {
    await openScreen(page, meta);
    await grantRows(page).nth(0).locator('button', { hasText: 'Reject' }).click();
    await expect(dialog(page)).toContainText('Yusuf Rahman does not get Risk Owner in ISMS.');
    await dialog(page).locator('button', { hasText: /^Reject$/ }).click();
    await expectToast(page, 'Risk Owner in ISMS for Yusuf Rahman rejected');
    await expect(grantRows(page)).toHaveCount(1);
  });

  for (const theme of ['light', 'dark']) {
    test(`readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(grantRows(page).nth(1)).toContainText('Pemberian peran ini untuk Anda; Tenant Admin lain yang memutuskannya.');
      await expectReadableText(page, 4.5);
      await grantRows(page).nth(0).locator('button', { hasText: 'Tolak' }).click();
      await expect(dialog(page)).toContainText('Tolak pemberian peran ini');
      await expectOverlayReadable(page);
    });
  }
});
