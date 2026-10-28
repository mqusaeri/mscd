import { readFile } from 'node:fs/promises';
import { test, expect, ui, go, openScreen, openRow, drawerFact, metaById, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow } from '../helpers.js';

// The Import screen of the sample build (MILESTONE-2 M2-08): CSV files of the Statement of Applicability and of the
// document register checked against the sample snapshot, the results with their filters, "Import N rows" kept back
// while a row has an error, and an import that the built-in screens then show. @sample-only: the API project covers
// the screen in e2e/api-only/import.spec.js.
const meta = metaById('import');
const main = (page) => page.locator('main');
const fileInput = (page) => main(page).locator('input[type="file"]');
const button = (page, name) => main(page).locator('button', { hasText: new RegExp(`^${name}$`) });
const csv = (lines) => ({ name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8') });

test.describe('Import screen @sample-only', () => {
  test('offers controls and documents, the template, and checks nothing before a file is chosen', async ({ page }) => {
    await openScreen(page, meta);
    await expect(main(page).locator('h1')).toHaveText('Import');
    await expect(main(page)).toContainText('Implementation');
    await expect(ui.nav(page, 'Import')).toHaveCSS('font-weight', '600');
    const kinds = main(page).locator('select option');
    await expect(kinds).toHaveText(['Controls and requirements (Statement of Applicability)', 'Documents (register only, no files)']);
    await expect(button(page, 'Check file')).toBeDisabled();
    await expect(main(page)).toContainText('Choose a file first');
    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Download template').click()]);
    expect(download.suggestedFilename()).toBe('isms-import-applicability.csv');
    const header = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe('"ID","Title","Theme","Applicable","Justification","Status","Owner","Implementing document","Frequency","Last evidence","Freshness","Integrity","Risks","Status note"');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('lists every row with its result, keeps the import back while a row has an error, and filters the rows', async ({ page }) => {
    await openScreen(page, meta);
    await fileInput(page).setInputFiles(csv([
      'ID,Applicable,Justification,Owner',
      'A.5.1,Yes,Required by risk treatment; see linked risks.,Rina Kusuma',
      'A.5.2,No,N/A,bagus',
      'A.99.9,Yes,,rina',
      'A.5.3,,,nobody',
    ]));
    await expect(main(page)).toContainText('import.csv');
    await button(page, 'Check file').click();
    const results = main(page).locator('.mx-card', { hasText: 'Check results' });
    await expect(results).toContainText('import.csv: 4 rows');
    await expect(results.locator('.mx-badge').first()).toHaveText('1 OK');
    await expect(results).toContainText('1 with a warning');
    await expect(results).toContainText('2 with an error');
    // Errors first: the filter starts on the rows with an error.
    await expect(results.locator('tbody tr')).toHaveCount(2);
    await expect(results.locator('tbody tr').nth(0)).toContainText('A.99.9 is not a control or clause of this system.');
    await expect(results.locator('tbody tr').nth(1)).toContainText('Owner: nobody is not an active member of this organisation.');
    await expect(button(page, 'Import 1 row')).toBeDisabled();
    await expect(results).toContainText('Correct the rows with an error and check the file again.');
    await results.locator('[role="tab"]', { hasText: 'All rows' }).click();
    await expect(results.locator('tbody tr')).toHaveCount(4);
    await results.locator('[role="tab"]', { hasText: 'Warnings' }).click();
    await expect(results.locator('tbody tr')).toHaveCount(1);
    await expect(results.locator('tbody tr')).toContainText('The exclusion justification does not look meaningful.');
    await expectReadableText(page, 4.5);
    await expectNoHorizontalOverflow(page);
    await button(page, 'Check another file').click();
    await expect(main(page)).toContainText('No file chosen');
  });

  test('imports new documents that the Document register then lists', async ({ page }) => {
    await openScreen(page, meta);
    await main(page).locator('select').selectOption('documents');
    await fileInput(page).setInputFiles(csv([
      'ID,Title,Type,Owner,Next review',
      'POL-01,Information Security Policy,Policy,,',
      'PRC-77,Remote working procedure,Procedure,dewi,2027-01-31',
    ]));
    await button(page, 'Check file').click();
    const results = main(page).locator('.mx-card', { hasText: 'Check results' });
    await expect(results).toContainText('POL-01 is already registered: the import leaves this document as it is.');
    await expect(results).toContainText('Rows with a warning are imported.');
    await button(page, 'Import 1 row').click();
    await expect(results).toContainText('Import finished');
    await expect(results).toContainText('1 created, 0 changed, 1 left as they were.');
    await button(page, 'Open Document register').click();
    await expect(ui.title(page)).toHaveText('Document register');
    await expect(main(page)).toContainText('PRC-77');
    await expect(main(page)).toContainText('Remote working procedure');
  });

  test('changes the owner of a control through an import of the Statement of Applicability', async ({ page }) => {
    await openScreen(page, meta);
    await fileInput(page).setInputFiles(csv(['ID,Owner', 'A.5.1,Bagus Prasetyo']));
    await button(page, 'Check file').click();
    await button(page, 'Import 1 row').click();
    await expect(main(page)).toContainText('0 created, 1 changed, 0 left as they were.');
    await button(page, 'Open Controls & requirements').click();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await openRow(page, 'A.5.1');
    await expect(drawerFact(page, 'Owner')).toHaveText('Bagus Prasetyo, IT Infrastructure Lead');
  });

  test('refuses an XLSX file in the sample build and explains it', async ({ page }) => {
    await openScreen(page, meta);
    await fileInput(page).setInputFiles({ name: 'soa.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK\u0003\u0004') });
    await button(page, 'Check file').click();
    await expect(main(page).locator('[role="alert"]').first()).toContainText('The sample build checks CSV files only.');
    await expect(main(page).locator('input[type="file"]')).toHaveAttribute('aria-invalid', 'true');
  });

  for (const theme of ['light', 'dark']) {
    test(`is readable in Indonesian, ${theme} theme, with its results`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(main(page)).toContainText('Yang diimpor');
      await expect(main(page)).toContainText('Unduh templat');
      await fileInput(page).setInputFiles(csv(['ID,Owner', 'A.5.1,nobody', 'A.5.2,bagus']));
      await button(page, 'Periksa berkas').click();
      await expect(main(page)).toContainText('Hasil pemeriksaan');
      await expect(main(page)).toContainText('Pemilik: nobody bukan anggota aktif organisasi ini.');
      await expectReadableText(page, 4.5);
      await expectNoTextOverflow(page);
    });
  }

  test('is in the sidebar of the manager only, and opens from it', async ({ page }) => {
    await page.goto('/?persona=owner');
    await expect(page.locator('main h1')).toBeVisible();
    await expect(ui.nav(page, 'Import')).toHaveCount(0);
    await page.goto('/');
    await go(page, 'Import');
    await expect(page.locator('main [data-screen="import"]')).toBeVisible();
  });
});
