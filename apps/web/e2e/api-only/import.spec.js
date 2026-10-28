import { test, expect, ui, go, openApp, expectToast, expectReadableText, expectNoHorizontalOverflow } from '../helpers.js';

// The Import screen against the api (MILESTONE-2 M2-08): the page action "Import" of Controls & requirements and
// Document register opens it with the kind of the screen, the XLSX template comes from the api, a CSV file is checked
// by the api row by row (`imports.create`), "Import N rows" stays back while a row has an error, and the import is
// queued (`imports.commit`, 202) and followed through its task. No worker runs in this stack (e2e-api/stack.mjs), so
// the import stays queued; the server integration tests apply it (apps/server/test/int/imports).
const main = (page) => page.locator('main');
const fileInput = (page) => main(page).locator('input[type="file"]');
const button = (page, name) => main(page).locator('button', { hasText: new RegExp(`^${name}$`) });
const csv = (lines) => ({ name: 'soa-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8') });

test.describe('Import against the api @api-only', () => {
  test('an MS Manager opens Import from Controls & requirements, checks a file and queues the import', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await ui.pageAction(page, 'Import').click();
    await expect(ui.title(page)).toHaveText('Import');
    await expect(main(page).locator('[data-screen="import"]')).toBeVisible();
    await expect(main(page).locator('select')).toHaveValue('applicability');
    await expect(main(page).locator('select option')).toHaveText([
      'Controls and requirements (Statement of Applicability)', 'Documents (register only, no files)', 'Risks', 'Evidence',
    ]);

    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Download template').click()]);
    expect(download.suggestedFilename()).toMatch(/import-applicability\.xlsx$/i);
    // The app language goes with the link, so the help sheet follows the app.
    expect(download.url()).toMatch(/\/imports\/templates\/applicability\?lang=en$/);

    await fileInput(page).setInputFiles(csv(['ID,Status note,Owner', 'A.5.1,Reviewed in the E2E run,rina', 'A.99.9,Unknown control,rina', 'A.5.2,Second note,nobody.here']));
    await button(page, 'Check file').click();
    const results = main(page).locator('.mx-card', { hasText: 'Check results' });
    await expect(results).toContainText('soa-e2e.csv: 3 rows');
    await expect(results).toContainText('2 with an error');
    await expect(results).toContainText('A.99.9 is not a control or clause of the edition this system uses.');
    await expect(results).toContainText('Owner: nobody.here is not an active member of this organisation.');
    await expect(button(page, 'Import 1 row')).toBeDisabled();
    await expect(results).toContainText('Correct the rows with an error and check the file again.');
    await expectReadableText(page, 4.5);
    await expectNoHorizontalOverflow(page);

    await button(page, 'Check another file').click();
    await fileInput(page).setInputFiles(csv(['ID,Status note', 'A.5.1,Reviewed in the E2E run', 'A.5.2,Reviewed in the E2E run too']));
    await button(page, 'Check file').click();
    await expect(results).toContainText('2 OK');
    await results.locator('[role="tab"]', { hasText: 'All rows' }).click();
    await expect(results.locator('tbody tr')).toHaveCount(2);
    await expect(results.locator('tbody tr').first()).toContainText('Change');
    await button(page, 'Import 2 rows').click();
    await expectToast(page, 'Importing 2 rows of controls and requirements');
    await expect(results).toContainText('Importing');
    await expect(results).toContainText('0% done. You can leave this page');
    await expect(button(page, 'Import 2 rows')).toHaveCount(0);
  });

  test('Document register opens Import for documents, and a file that is not the template is refused', async ({ page }) => {
    await openApp(page);
    await go(page, 'Document register');
    await ui.pageAction(page, 'Import').click();
    await expect(main(page).locator('select')).toHaveValue('documents');
    await fileInput(page).setInputFiles(csv(['Code,Name', 'X-1,Something']));
    await button(page, 'Check file').click();
    await expect(main(page).locator('[role="alert"]').first()).toContainText('The header row does not match the template.');
    await expect(main(page)).toContainText('Columns that are not in the template: Code, Name');
    await expect(fileInput(page)).toHaveAttribute('aria-invalid', 'true');
    for (const theme of ['dark', 'light']) {
      await page.locator('header button[title="Theme"]').click();
      await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', theme);
      await expectReadableText(page, 4.5);
    }
  });

  test.describe('as a Domain Owner', () => {
    test.use({ apiSession: 'bagus' });
    test('imports evidence only, and Controls & requirements has no Import', async ({ page }) => {
      await openApp(page);
      await go(page, 'Controls & requirements');
      await expect(ui.pageAction(page, 'Import')).toHaveCount(0);
      await go(page, 'Import');
      await expect(main(page).locator('select option')).toHaveText(['Evidence']);
    });
  });

  test.describe('as Top Management', () => {
    test.use({ apiSession: 'hendra' });
    test('has no Import in the sidebar', async ({ page }) => {
      await openApp(page);
      await expect(ui.nav(page, 'Import')).toHaveCount(0);
    });
  });
});
