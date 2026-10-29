import { test, expect, ui, go, openApp, openRow, listRow, search, expectToast, expectOverlayReadable } from '../helpers.js';

// The evidence forms against the api (MILESTONE-2 M2-11). rina, MS Manager of the demo ISMS, creates evidence from the
// page action "New evidence" of Evidence freshness (`evidence.create`) and attaches its first file from the SharePoint
// picker (`evidence.files`); edits a record (`evidence.update`), adds a target in another system and removes it again
// (`evidence.targets.create`, `evidence.targets.remove`); and sets and resets the freshness limits of a frequency
// (`freshness.thresholds.*`), which change the freshness bands of Evidence freshness at once. bagus (Domain Owner) adds
// evidence with himself as the owner and reads the limits only.
const panel = (page) => ui.drawer(page).locator('[data-m11="evidence"]');
const dialog = (page) => ui.modal(page);
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
const band = (page, code) => listRow(page, code).locator('td:nth-child(7)');

// True when the evidence list rows carry every target of the record with its id (`targets` of EvidenceItem), which the
// panel needs for Remove on a target the record had before this session.
async function listsTargetIds(page, baseURL, code) {
  const res = await page.request.get(`${baseURL}/api/v1/ms/isms/evidence?q=${encodeURIComponent(code)}&pageSize=50`);
  expect(res.ok()).toBe(true);
  const row = (await res.json()).items.find((i) => i.code === code);
  return Array.isArray(row?.targets) && row.targets.every((t) => typeof t.id === 'string');
}

// The header is under the backdrop of an open drawer or form, so the check switches the theme attribute of the app root
// itself (the tokens of src/styles.css follow it), measures the open layer, and puts the light theme back.
async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Evidence forms against the api @api-only', () => {
  test('New evidence creates a record for a control and attaches its first file from the picker', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    await ui.pageAction(page, 'New evidence').click();
    await expect(dialog(page)).toContainText('New evidence');
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    expect(code).toMatch(/^EV-\d+$/);
    await dialog(page).locator('input[name="title"]').fill('Quarterly firewall rule review');
    await dialog(page).locator('select[name="frequencyCode"]').selectOption('quarterly');
    await dialog(page).locator('input[type="search"]').first().fill('A.8.20');
    await dialog(page).locator('[role="option"]').first().click();
    await expect(dialog(page).locator('.mx-m11-codes')).toContainText('A.8.20');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Create evidence').click();
    await expect(dialog(page)).toContainText('Attach the first file');
    await expect(dialog(page)).toContainText(`${code} has no file yet`);
    await expect(dialog(page).locator('.mx-empty-art svg')).toBeVisible();
    await button(dialog(page), 'Choose file').click();
    const picker = ui.modal(page);
    await expect(picker).toContainText('Compliance / ISMS / Evidence');
    const files = picker.locator('button[style*="grid-template-columns: 1fr auto"]');
    await expect(files.first()).toBeVisible();
    const name = (await files.first().innerText()).split('\n')[0].trim();
    await button(picker, 'Link selected file').click();
    await expectToast(page, `${code}: ${name} attached`);
    await expect(ui.modal(page)).toHaveCount(0);
    await search(page, code);
    await expect(listRow(page, code)).toContainText('Quarterly firewall rule review');
    await expect(listRow(page, code)).toContainText('A.8.20');
  });

  test('New evidence with Later keeps the record without a file, and Evidence freshness lists it as critical', async ({ page }) => {
    // Evidence without a file has the repository slug '' (G.5 `loc`); src/data/api/wire.ts gives that slug an entry in
    // LOC, so the built-in screens show the record after the load that follows Later.
    await openApp(page);
    await go(page, 'Evidence freshness');
    await ui.pageAction(page, 'New evidence').click();
    const code = await dialog(page).locator('input[name="code"]').inputValue();
    await dialog(page).locator('input[name="title"]').fill('Supplier security review');
    await dialog(page).locator('select[name="frequencyCode"]').selectOption('annual');
    await dialog(page).locator('input[type="search"]').first().fill('A.5.19');
    await dialog(page).locator('[role="option"]').first().click();
    await button(dialog(page), 'Create evidence').click();
    await expect(dialog(page)).toContainText('Attach the first file');
    await button(dialog(page), 'Later').click();
    await expect(ui.modal(page)).toHaveCount(0);
    await search(page, code);
    await expect(listRow(page, code)).toContainText('Supplier security review');
    await expect(listRow(page, code)).toContainText('A.5.19');
    await expect(band(page, code)).toHaveText('Critical');
    await openRow(page, code);
    await expect(ui.drawer(page)).toContainText('Supplier security review');
    await expect(panel(page)).toContainText('A.5.19 in ISMS');
  });

  test('the evidence panel edits a record, adds a target in another system and removes it again', async ({ page, baseURL }) => {
    expect(await listsTargetIds(page, baseURL, 'EV-0313')).toBe(true);
    await openApp(page);
    await go(page, 'Evidence freshness');
    await search(page, 'EV-0313');
    await openRow(page, 'EV-0313');
    await expect(panel(page)).toContainText('A.8.13 in ISMS');
    // EV-0313 has one target: its Remove stays disabled with the reason.
    await expect(button(panel(page), 'Remove A.8.13')).toBeDisabled();
    await expect(panel(page).locator('li', { hasText: 'A.8.13 in ISMS' })).toContainText('An evidence record keeps at least one target.');

    await button(panel(page), 'Edit evidence').click();
    await dialog(page).locator('input[name="title"]').fill('Backup job log and restore test');
    await dialog(page).locator('select[name="classification"]').selectOption('confidential');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Save').click();
    await expectToast(page, 'EV-0313 saved');

    await go(page, 'Evidence freshness');
    await search(page, 'EV-0313');
    await openRow(page, 'EV-0313');
    await expect(ui.drawer(page)).toContainText('Backup job log and restore test');
    await button(panel(page), 'Add target').click();
    await dialog(page).locator('select[name="system"]').selectOption('qms');
    await dialog(page).locator('input[type="search"]').fill('7.5');
    await dialog(page).locator('[role="option"]').first().click();
    await dialog(page).locator('textarea[name="mappingNote"]').fill('The backup log also proves control of documented information.');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(dialog(page), 'Add target').click();
    // A mapping marked not reusable gives the BR-23 warning; the form then stays open with it.
    await expect.poll(async () => (await dialog(page).count()) === 0 || (await dialog(page).innerText()).includes('Saved. Check the warnings below.')).toBe(true);
    if (await dialog(page).count()) await button(dialog(page), 'Close').click();
    const added = panel(page).locator('li', { hasText: 'in QMS' });
    await expect(added).toBeVisible();
    // Two targets now, each with the id the evidence list gives: both can be removed.
    await expect(button(panel(page), 'Remove A.8.13')).toBeEnabled();
    await expect(panel(page)).not.toContainText('Remove is not available for this target yet.');
    await expect(added.locator('button')).toBeEnabled();
    await added.locator('button').click();
    await dialog(page).locator('textarea').fill('Mapped to the wrong clause');
    await button(dialog(page), 'Remove target').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(panel(page).locator('li', { hasText: 'in QMS' })).toHaveCount(0);
  });

  test('Remove target removes a target the record had before, and never the last one', async ({ page, baseURL }) => {
    expect(await listsTargetIds(page, baseURL, 'EV-0313')).toBe(true);
    await openApp(page);
    await go(page, 'Evidence freshness');
    await search(page, 'EV-0313');
    await openRow(page, 'EV-0313');
    await expect(button(panel(page), 'Remove A.8.13')).toBeDisabled();
    await expect(panel(page).locator('li', { hasText: 'A.8.13 in ISMS' })).toContainText('An evidence record keeps at least one target.');
    await button(panel(page), 'Add target').click();
    await dialog(page).locator('input[type="search"]').fill('A.8.14');
    await dialog(page).locator('[role="option"]').first().click();
    await button(dialog(page), 'Add target').click();
    await expect(dialog(page)).toHaveCount(0);
    const second = panel(page).locator('li', { hasText: 'A.8.14 in ISMS' });
    await expect(second).toBeVisible();
    await button(panel(page), 'Remove A.8.13').click();
    await dialog(page).locator('textarea').fill('The restore test belongs to A.8.14');
    await button(dialog(page), 'Remove target').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(panel(page).locator('li', { hasText: 'A.8.13 in ISMS' })).toHaveCount(0);
    await expect(second.locator('button')).toBeDisabled();
    await expect(second).toContainText('An evidence record keeps at least one target.');
  });

  test('Freshness limits sets the limits of a frequency for the system and resets them to the default', async ({ page }) => {
    await openApp(page);
    await go(page, 'Evidence freshness');
    // EV-0292 is monthly evidence produced 67 days ago: critical under the default limits (more than 2 x 30 days).
    await search(page, 'EV-0292');
    await expect(band(page, 'EV-0292')).toHaveText('Critical');
    await ui.pageAction(page, 'Freshness limits').click();
    await expect(dialog(page)).toContainText('Freshness limits of ISMS');
    const monthly = dialog(page).locator('form[data-frequency="monthly"]');
    await expect(monthly).toContainText('Default');
    await monthly.locator('input[name="graceDays"]').fill('5');
    await monthly.locator('input[name="agingFactor"]').fill('1.5');
    await monthly.locator('input[name="expiredFactor"]').fill('3');
    await inBothThemes(page, () => expectOverlayReadable(page));
    await button(monthly, 'Save').click();
    await expectToast(page, 'Freshness limits of Monthly saved');
    await expect(monthly).toContainText('Set for this system');
    // The server works out the bands when the system is read, and the save loads it again: 67 days is within 3 x 30.
    await button(dialog(page), 'Close').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(band(page, 'EV-0292')).toHaveText('Expired');

    await ui.pageAction(page, 'Freshness limits').click();
    await button(dialog(page).locator('form[data-frequency="monthly"]'), 'Reset to default').click();
    await expectToast(page, 'Freshness limits of Monthly back to the default');
    await expect(dialog(page).locator('form[data-frequency="monthly"]')).toContainText('Default');
    await expect(dialog(page).locator('form[data-frequency="monthly"] input[name="graceDays"]')).toHaveValue('1');
    await button(dialog(page), 'Close').click();
    await expect(band(page, 'EV-0292')).toHaveText('Critical');
  });

  test.describe('as a Domain Owner', () => {
    test.use({ apiSession: 'bagus' });
    test('adds evidence with himself as the owner and reads the freshness limits only', async ({ page }) => {
      await openApp(page);
      await go(page, 'Evidence freshness');
      await ui.pageAction(page, 'New evidence').click();
      await expect(dialog(page)).toContainText('You add evidence with yourself as the owner.');
      await expect(dialog(page).locator('select').nth(1)).toBeDisabled();
      await page.keyboard.press('Escape');
      await ui.pageAction(page, 'Freshness limits').click();
      await expect(dialog(page)).toContainText('Only the Management System Manager of this system changes the limits.');
      await expect(dialog(page).locator('form[data-frequency="monthly"] input[name="graceDays"]')).toBeDisabled();
      await expect(dialog(page).locator('form[data-frequency="monthly"] button')).toHaveCount(0);
    });
  });
});
