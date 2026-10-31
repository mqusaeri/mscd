import {
  test, expect, ui, go, openScreen, metaById, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';
import * as D from '../../src/data/mscd-data.js';

// Open work totals of the sample build (MILESTONE-3 M3-08, D.10): the sample build opens the screen by its address
// (`?screen=pending-totals&persona=top`, C.1), the totals of the ISMS equal those of Chain stages (63 open, 24 overdue
// or missing), the stage by role table names roles and never a person, "All my systems" lists the four systems, and
// Chain stages and the Overview keep the page actions of the generated views (the action that opens the screen shows in
// API builds only). @sample-only: the API project covers the screen in e2e/api-only/pending-totals.spec.js.
const meta = metaById('pending-totals');
const body = (page) => page.locator('main [data-screen="pending-totals"]');
const stats = (page) => body(page).locator('ul[data-total-open]');
const stat = (page, name) => body(page).locator(`[data-stat="${name}"] [data-value]`);
const matrix = (page) => body(page).locator('.mx-pt-matrix table');
const cell = (page, stage, role) => matrix(page).locator(`tr[data-stage="${stage}"] td[data-role="${role}"]`);
const tab = (page, name) => body(page).locator('[role="tab"]', { hasText: new RegExp(`^${name}$`) });
const systemRow = (page, ms) => body(page).locator(`.mx-pt-all tr[data-ms="${ms}"]`);
/** Every name of the sample organisation's people; the page shows none of them (product decision 2). */
const NAMES = Object.entries(D.PEOPLE).filter(([h]) => h !== 'none').map(([, p]) => p[0]);
/** Open items per stage of the ISMS, as the stage tabs of Chain stages count them (e2e/chain.spec.js). */
const ISMS_STAGES = { context: 1, risk: 5, treatment: 4, control: 28, soa: 3, document: 8, evidence: 10, metric: 4 };

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

/** The screen body names nobody (the top bar shows the signed-in person, as on every screen). */
async function expectNoNames(page) {
  const text = await body(page).innerText();
  for (const name of NAMES) expect(text, `${name} on the page`).not.toContain(name);
}

test.describe('Open work totals @sample-only', () => {
  test('Top Management reads the ISMS totals per stage and role, equal to Chain stages, without any name', async ({ page }) => {
    await openScreen(page, meta);
    await expect(ui.title(page)).toHaveText('Open work totals');
    await expect(body(page)).toContainText('This screen shows counts only. It never shows who holds an item.');
    await expect(tab(page, 'This system')).toHaveAttribute('aria-selected', 'true');
    await expect(body(page).locator('h2').first()).toHaveText('Open work in ISMS');
    await expect(stats(page)).toHaveAttribute('data-total-open', '63');
    await expect(stats(page)).toHaveAttribute('data-total-overdue', '24');
    await expect(stat(page, 'open')).toHaveText('63');
    await expect(stat(page, 'overdue')).toHaveText('24');
    await expect(body(page).locator('[data-stat="overdue"]')).toContainText('38% of the open items');
    await expect(stat(page, 'ontime')).toHaveText('39');
    await expect(stat(page, 'stages')).toHaveText('8 of 8');

    await expect(matrix(page).locator('thead th')).toHaveText(['Stage', 'Management System Manager', 'Domain Owner', 'Top Management', 'No role or unassigned', 'All roles']);
    await expect(matrix(page).locator('tbody th')).toHaveText(['Context issue', 'Risk', 'Risk treatment', 'Control', 'SoA', 'Document', 'Evidence', 'Metric']);
    for (const [stage, open] of Object.entries(ISMS_STAGES)) {
      await expect(cell(page, stage, 'all'), stage).toHaveAttribute('data-open', String(open));
      // The role cells of a stage add up to its total.
      const parts = await matrix(page).locator(`tr[data-stage="${stage}"] td:not([data-role="all"])`).evaluateAll((tds) => tds.map((td) => Number(td.dataset.open)));
      expect(parts.reduce((a, b) => a + b, 0), stage).toBe(open);
    }
    await expect(cell(page, 'control', 'all')).toContainText('28');
    await expect(cell(page, 'all', 'all')).toHaveAttribute('data-open', '63');
    await expect(cell(page, 'all', 'all')).toHaveAttribute('data-overdue', '24');
    await expect(cell(page, 'all', 'all')).toContainText('24 overdue');
    await expectNoNames(page);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await inBothThemes(page, () => expectReadableText(page, 4.5));
  });

  test('"All my systems" lists every system with its totals, stays in the address and opens the table of another system', async ({ page }) => {
    await openScreen(page, meta);
    await tab(page, 'All my systems').click();
    await expect(tab(page, 'All my systems')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=all/);
    const want = { isms: [63, 24], qms: [18, 5], bcms: [24, 2], abms: [34, 3] };
    for (const [ms, [open, overdue]] of Object.entries(want)) {
      await expect(systemRow(page, ms), ms).toHaveAttribute('data-open', String(open));
      await expect(systemRow(page, ms), ms).toHaveAttribute('data-overdue', String(overdue));
    }
    await expect(systemRow(page, 'isms')).toContainText('ISMS');
    await expect(systemRow(page, 'isms')).toContainText('Selected system');
    await expect(systemRow(page, 'all')).toHaveAttribute('data-open', '139');
    await expect(systemRow(page, 'all')).toHaveAttribute('data-overdue', '34');
    await expect(systemRow(page, 'all')).toContainText('24%');
    await expectNoNames(page);
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    // The tab is part of the address (M2-20): a reload keeps it.
    await page.reload();
    await expect(tab(page, 'All my systems')).toHaveAttribute('aria-selected', 'true');
    await expect(systemRow(page, 'qms')).toHaveAttribute('data-open', '18');

    await systemRow(page, 'qms').locator('button', { hasText: 'Show table' }).click();
    await expect(tab(page, 'This system')).toHaveAttribute('aria-selected', 'true');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect(body(page).locator('h2').first()).toHaveText('Open work in QMS');
    await expect(stats(page)).toHaveAttribute('data-total-open', '18');
    await expect(matrix(page).locator('tbody th')).toHaveText(['Context issue', 'Risk & opportunity', 'Action', 'Process / requirement', 'Quality objective', 'Document', 'Evidence', 'Metric']);
    await expect(page).toHaveURL(/ms=qms/);
  });

  test('shows the screen in Indonesian with the same totals', async ({ page }) => {
    await openScreen(page, meta, 'lang=id');
    await expect(ui.title(page)).toHaveText('Total pekerjaan terbuka');
    await expect(body(page)).toContainText('Layar ini hanya menampilkan jumlah.');
    await expect(tab(page, 'Sistem ini')).toHaveAttribute('aria-selected', 'true');
    await expect(body(page).locator('h2').first()).toHaveText('Pekerjaan terbuka di ISMS');
    await expect(stat(page, 'stages')).toHaveText('8 dari 8');
    await expect(matrix(page).locator('thead th')).toHaveText(['Tahap', 'Management System Manager', 'Pemilik Domain', 'Manajemen Puncak', 'Tanpa peran atau belum ditugaskan', 'Semua peran']);
    await expect(cell(page, 'all', 'all')).toContainText('24 terlambat');
    await tab(page, 'Semua sistem saya').click();
    await expect(systemRow(page, 'all')).toContainText('Semua sistem');
    await expect(systemRow(page, 'bcms').locator('button')).toHaveText('Lihat tabel');
  });

  test('the Management System Manager opens the same screen; the sample build keeps the page actions of Chain stages and the Overview', async ({ page }) => {
    await page.goto('/?screen=pending-totals&persona=manager');
    await expect(ui.title(page)).toHaveText('Open work totals');
    await expect(stats(page)).toHaveAttribute('data-total-open', '63');
    // The built-in action shows first: the page actions of a screen render together, so the check of the absent action
    // after it reads the final list.
    await go(page, 'Chain stages');
    await expect(ui.pageAction(page, 'Remind all holders')).toBeVisible();
    await expect(page.locator('main button[title="Open work totals"]')).toHaveCount(0);
    await go(page, 'Overview');
    await expect(ui.pageAction(page, 'Readiness report')).toBeVisible();
    await expect(page.locator('main button[title="Open work totals"]')).toHaveCount(0);
    // The screen has no sidebar entry (D3-02).
    await expect(ui.nav(page, 'Open work totals')).toHaveCount(0);
  });
});
