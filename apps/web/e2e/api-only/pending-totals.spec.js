import { test, expect, ui, go, openApp, expectReadableText, expectNoHorizontalOverflow } from '../helpers.js';

// Open work totals against the api (MILESTONE-3 M3-08, D.10). hendra is Top Management in every system of PT Nusantara
// Digital Teknologi (`audit.pending.aggregate`, F.6): he opens the screen from Chain stages and the Overview, and the
// totals, the stage by role table and "All my systems" equal the answers of `GET /ms/{ms}/audit/pending?aggregate=unit`.
// No member's name appears on the screen (product decision 2). bagus, a Domain Owner, holds no such right: neither page
// action shows, the address does not open the screen and the api refuses the counts.
const body = (page) => page.locator('main [data-screen="pending-totals"]');
const stats = (page) => body(page).locator('ul[data-total-open]');
const matrix = (page) => body(page).locator('.mx-pt-matrix table');
const cell = (page, stage, role) => matrix(page).locator(`tr[data-stage="${stage}"] td[data-role="${role}"]`);
const tab = (page, name) => body(page).locator('[role="tab"]', { hasText: new RegExp(`^${name}$`) });
const systemRow = (page, ms) => body(page).locator(`.mx-pt-all tr[data-ms="${ms}"]`);
const action = (page) => page.locator('main button[title="Open work totals"]');

/** The answer of aggregate=unit for a system, read with the session of the page. */
async function aggregate(page, ms) {
  const res = await page.request.get(`/api/v1/ms/${ms}/audit/pending?aggregate=unit`);
  expect(res.status(), `aggregate=unit of ${ms}`).toBe(200);
  const rows = await res.json();
  expect(Array.isArray(rows)).toBe(true);
  for (const row of rows) expect(Object.keys(row).sort()).toEqual(['open', 'overdue', 'role', 'stage']);
  return rows;
}
const sum = (rows) => rows.reduce((s, r) => ({ open: s.open + r.open, overdue: s.overdue + r.overdue }), { open: 0, overdue: 0 });
const selectedMs = (page) => new URL(page.url()).searchParams.get('ms');

/** The display names of the organisation's members with a business role (`PEOPLE` of the snapshot). */
async function memberNames(page) {
  const res = await page.request.get('/api/v1/ui/org');
  expect(res.ok()).toBe(true);
  const { PEOPLE } = await res.json();
  const names = Object.entries(PEOPLE).filter(([handle]) => handle !== 'none').map(([, p]) => p[0]);
  expect(names.length).toBeGreaterThan(5);
  return names;
}

/** The screen body names nobody (the top bar shows the signed-in person, as on every screen). */
async function expectNoNames(page, names) {
  const text = await body(page).innerText();
  for (const name of names) expect(text, `${name} on the screen`).not.toContain(name);
}

/** The table and the totals of the open system against its api answer. */
async function expectTotalsOf(page, rows) {
  const total = sum(rows);
  await expect(stats(page)).toHaveAttribute('data-total-open', String(total.open));
  await expect(stats(page)).toHaveAttribute('data-total-overdue', String(total.overdue));
  const roles = [...new Set(rows.map((r) => r.role ?? 'none'))];
  // A column per role that holds open work, then "All roles".
  await expect(matrix(page).locator('thead th')).toHaveCount(roles.length + 2);
  for (const r of rows) {
    const where = cell(page, r.stage, r.role ?? 'none');
    await expect(where, `${r.stage} ${r.role}`).toHaveAttribute('data-open', String(r.open));
    await expect(where, `${r.stage} ${r.role}`).toHaveAttribute('data-overdue', String(r.overdue));
    await expect(where).toContainText(String(r.open));
  }
  for (const stage of new Set(rows.map((r) => r.stage))) {
    const of = sum(rows.filter((r) => r.stage === stage));
    await expect(cell(page, stage, 'all'), stage).toHaveAttribute('data-open', String(of.open));
    await expect(cell(page, stage, 'all'), stage).toHaveAttribute('data-overdue', String(of.overdue));
  }
  await expect(cell(page, 'all', 'all')).toHaveAttribute('data-open', String(total.open));
  await expect(cell(page, 'all', 'all')).toHaveAttribute('data-overdue', String(total.overdue));
}

async function inBothThemes(page, check) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.querySelectorAll('.mscd').forEach((el) => el.setAttribute('data-theme', t)), theme);
    await check();
  }
}

test.describe('Open work totals against the api @api-only', () => {
  test.use({ apiSession: 'hendra' });

  test('hendra opens the totals from Chain stages: they equal the api answer and name no member', async ({ page }) => {
    await openApp(page);
    await go(page, 'Chain stages');
    const ms = selectedMs(page);
    expect(ms).toBeTruthy();
    await action(page).click();
    await expect(ui.title(page)).toHaveText('Open work totals');
    await expect(body(page)).toContainText('This screen shows counts only. It never shows who holds an item.');
    await expect(tab(page, 'This system')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`/pending-totals\\?.*ms=${ms}`));
    const rows = await aggregate(page, ms);
    expect(sum(rows).open).toBeGreaterThan(0);
    await expectTotalsOf(page, rows);
    await expectNoNames(page, await memberNames(page));
    await expectNoHorizontalOverflow(page);
    await inBothThemes(page, () => expectReadableText(page, 4.5));
  });

  test('"All my systems" equals the api answer of every system, and "Show table" opens another system', async ({ page }) => {
    await openApp(page);
    await go(page, 'Chain stages');
    await action(page).click();
    await tab(page, 'All my systems').click();
    await expect(page).toHaveURL(/tab=all/);
    const me = await (await page.request.get('/api/v1/me')).json();
    const org = me.orgs.find((o) => o.id === me.org.slug);
    const systems = org.ms.filter((id) => (me.permissions.ms[id] || []).includes('audit.pending.aggregate'));
    expect(systems.length).toBeGreaterThan(1);
    await expect(body(page).locator('.mx-pt-all tbody tr')).toHaveCount(systems.length);
    let all = { open: 0, overdue: 0 };
    for (const ms of systems) {
      const total = sum(await aggregate(page, ms));
      all = { open: all.open + total.open, overdue: all.overdue + total.overdue };
      await expect(systemRow(page, ms), ms).toHaveAttribute('data-open', String(total.open));
      await expect(systemRow(page, ms), ms).toHaveAttribute('data-overdue', String(total.overdue));
    }
    await expect(systemRow(page, 'all')).toHaveAttribute('data-open', String(all.open));
    await expect(systemRow(page, 'all')).toHaveAttribute('data-overdue', String(all.overdue));
    await expectNoNames(page, await memberNames(page));
    await inBothThemes(page, () => expectReadableText(page, 4.5));

    const other = systems.find((ms) => ms !== selectedMs(page));
    await systemRow(page, other).locator('button', { hasText: 'Show table' }).click();
    await expect(tab(page, 'This system')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`ms=${other}`));
    await expect(body(page).locator('h2').first()).toHaveText(`Open work in ${other.toUpperCase()}`);
    await expectTotalsOf(page, await aggregate(page, other));
  });

  test('the Overview opens the screen too, and a system without open work shows the all-done scene', async ({ page }) => {
    await openApp(page);
    await go(page, 'Overview');
    await expect(ui.pageAction(page, 'Readiness report')).toBeVisible();
    await action(page).click();
    await expect(ui.title(page)).toHaveText('Open work totals');
    await expect(stats(page)).toBeVisible();
    // The api answers no open item: the empty state of the screen instead of the table.
    await page.route((url) => url.pathname.endsWith('/audit/pending') && url.searchParams.get('aggregate') === 'unit', (route) => route.fulfill({ json: [] }));
    await tab(page, 'All my systems').click();
    await expect(systemRow(page, 'all')).toHaveAttribute('data-open', '0');
    await tab(page, 'This system').click();
    await expect(body(page).locator('[data-empty]')).toContainText(/No open work in [A-Z]+/);
    await expect(body(page).locator('[data-empty] svg')).toBeVisible();
    await expect(matrix(page)).toHaveCount(0);
    await inBothThemes(page, () => expectReadableText(page, 4.5));
  });
});

test.describe('Open work totals for the Management System Manager @api-only', () => {
  test('rina, who holds the right too, opens the totals of her system from Chain stages', async ({ page }) => {
    await openApp(page);
    await go(page, 'Chain stages');
    const ms = selectedMs(page);
    await action(page).click();
    await expect(ui.title(page)).toHaveText('Open work totals');
    await expectTotalsOf(page, await aggregate(page, ms));
  });
});

test.describe('Open work totals for a Domain Owner @api-only', () => {
  test.use({ apiSession: 'bagus' });

  test('bagus sees no page action, cannot open the screen by its address and the api refuses the counts', async ({ page }) => {
    await openApp(page);
    await go(page, 'Overview');
    // The built-in action shows first: the page actions of a screen render together, so the count after it reads the
    // final list.
    await expect(ui.pageAction(page, 'Readiness report')).toBeVisible();
    await expect(action(page)).toHaveCount(0);
    const ms = selectedMs(page);
    const res = await page.request.get(`/api/v1/ms/${ms}/audit/pending?aggregate=unit`, { failOnStatusCode: false });
    expect(res.status()).toBe(403);
    await page.goto(`/pending-totals?ms=${ms}`);
    await expect(ui.title(page)).toBeVisible();
    await expect(ui.title(page)).not.toHaveText('Open work totals');
    await expect(body(page)).toHaveCount(0);
  });
});
