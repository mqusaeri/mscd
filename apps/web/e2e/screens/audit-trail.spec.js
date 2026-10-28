import {
  test, expect, ui, openApp, openScreen, metaById, switchRole, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow,
  expectNoTextOverflow,
} from '../helpers.js';

// Audit trail of the sample build (MILESTONE-2 M2-15): the entries of the ISMS, the filters by action, person and
// dates, an entry with its changed fields, "Verify chain", "Export CSV", "Download anchors" and the organisation's
// metadata. @sample-only: the API project covers the screen in e2e/api-only/audit-trail.spec.js.
const meta = metaById('audit-trail');
const rows = (page) => page.locator('main table tbody tr');
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Audit trail @sample-only', () => {
  test('lists the entries of the system and filters them by action, person and dates', async ({ page }) => {
    await openScreen(page, meta);
    await expect(rows(page).first()).toBeVisible();
    const total = await rows(page).count();
    expect(total).toBeGreaterThan(10);
    await expect(page.locator('main [data-trail-count]')).toHaveText(`${total} of ${total} entries`);
    await page.locator('main select[name="action"]').selectOption('document.transition');
    await expect(rows(page).first()).toContainText('document.transition');
    for (const text of await rows(page).allInnerTexts()) expect(text).toContain('document.transition');
    await expect(page.locator('main')).toContainText('Action and person filter the');
    await page.locator('main select[name="action"]').selectOption('');
    await page.locator('main select[name="person"]').selectOption({ label: 'Rina Kusuma' });
    for (const text of await rows(page).allInnerTexts()) expect(text).toContain('Rina Kusuma');
    await button(page.locator('main'), 'Clear filters').click();
    await page.locator('main input[name="from"]').fill('2030-01-01');
    await expect(page.locator('main')).toContainText('No entry matches.');
    await page.locator('main input[name="to"]').fill('2029-01-01');
    await expect(page.locator('main')).toContainText('The start date must not be after the end date.');
    await button(page.locator('main'), 'Clear filters').click();
    await expect(rows(page)).toHaveCount(total);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('opens an entry with its changes, verifies the chain and downloads the CSV and the anchors', async ({ page }) => {
    await openScreen(page, meta);
    await rows(page).filter({ hasText: 'applicability.transition' }).first().click();
    await expect(ui.drawer(page)).toContainText('Audit entry');
    await expect(ui.drawer(page)).toContainText('implementation_status:');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);

    await button(page.locator('main'), 'Verify chain').click();
    await expect(page.locator('main [data-chain-result="intact"]')).toContainText('Every chain is intact.');
    await expect(page.locator('main [data-chain-result]')).toContainText('org_ndt.audit_trail: intact');
    const [csv] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Export CSV').click()]);
    expect(csv.suggestedFilename()).toMatch(/^audit-trail-isms-.*\.csv$/);
    await expectToast(page, 'Audit trail exported');
    const [anchors] = await Promise.all([page.waitForEvent('download'), button(page.locator('main'), 'Download anchors').click()]);
    expect(anchors.suggestedFilename()).toMatch(/^audit-anchors-.*\.ndjson$/);
  });

  test('shows who and when for the whole organisation, and speaks Indonesian', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main select[name="view"]').selectOption('org');
    await expect(page.locator('main thead')).toContainText('System');
    await expect(page.locator('main button', { hasText: 'Export CSV' })).toBeDisabled();
    await expect(page.locator('main')).toContainText('Export works per management system.');
    await rows(page).first().click();
    await expect(ui.drawer(page)).toContainText('Only who and when are shown at organisation level.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await page.keyboard.press('Escape');

    await openScreen(page, meta, 'lang=id');
    await expect(page.locator('main thead')).toContainText('Tindakan');
    await expect(button(page.locator('main'), 'Verifikasi rantai')).toBeVisible();
  });

  test('the Internal Auditor and Top Management have no audit trail, as in API builds (F.6)', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('aside nav button[title="Audit trail"]')).toHaveCount(1);
    for (const persona of ['Internal Auditor', 'Top Management']) {
      await switchRole(page, persona);
      await expect(page.locator('aside nav button[title="Audit trail"]')).toHaveCount(0);
    }
  });
});
