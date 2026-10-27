import {
  test, expect, ui, HOST_METAS, openScreen, openApp, go, navFor, expectNoHorizontalOverflow, expectReadableText,
} from '../helpers.js';

// The pattern of a screen spec (MILESTONE-2 C.2, D2-04): every host screen of src/screens is probed through its
// meta.json, as the persona and in the way the file names, in both languages. A screen package copies the shape for
// its own spec in e2e/screens/<screen>.spec.js. @sample-only: the ?screen= opener exists in sample builds only.
// The first breadcrumb of a host screen is its sidebar group (screens/host.tsx GROUP_LABELS), or the organisation.
const GROUPS = { impl: ['Implementation', 'Implementasi'], audit: ['Audit', 'Audit'], surv: ['Surveillance', 'Surveilans'], admin: ['Administration', 'Administrasi'], ops: ['Operations', 'Operasi'] };

test.describe('Host screen probe @sample-only', () => {
  for (const meta of HOST_METAS) {
    test(`${meta.id} opens with its title, breadcrumb, page actions and help`, async ({ page }) => {
      for (const [lang, query] of [[0, ''], [1, 'lang=id']]) {
        await openScreen(page, meta, query);
        await expect(ui.title(page)).toHaveText(meta.label[lang]);
        await expect(page.locator('main [data-screen="' + meta.id + '"]')).toBeVisible();
        const crumbs = ui.title(page).locator('xpath=preceding-sibling::div[1]');
        if (GROUPS[meta.group]) await expect(crumbs).toHaveText(`${GROUPS[meta.group][lang]}/${meta.label[lang]}`);
        const actions = page.locator('main > div > div:first-child button[title]');
        await expect(actions).toHaveText(meta.pageActions.map((p) => p[lang]));
        const tera = page.locator(`button[title="${['Ask Tera', 'Tanya Tera'][lang]}"]`);
        await tera.click({ force: true });
        await expect(ui.teraCard(page)).toContainText(meta.label[lang]);
        await expect(ui.teraCard(page).locator('ol li').first()).toBeVisible();
        await ui.teraCard(page).locator('button', { hasText: ['Got it', 'Mengerti'][lang] }).click();
        await expect(ui.teraCard(page)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await expectReadableText(page, 4.5);
      }
    });
  }

  test('?screen= with an unknown id keeps the landing screen, and the sidebar counts the host screens', async ({ page }) => {
    await page.goto('/?screen=does-not-exist');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expect(ui.navItems(page)).toHaveCount(await navFor(page, 'manager'));
  });

  test('a host screen in the sidebar is kept while switching system and left for a persona without it', async ({ page }) => {
    const meta = HOST_METAS.find((m) => m.open === 'nav' && m.roles.includes('manager') && !m.roles.includes('owner'));
    test.skip(!meta, 'no host screen in the manager sidebar that the owner cannot open');
    await openApp(page);
    await go(page, meta.label[0]);
    await ui.msSwitch(page).click();
    await page.locator('header div[style*="width: 420px"] button').filter({ hasText: 'QMS' }).first().click();
    await expect(ui.title(page)).toHaveText(meta.label[0]);
    await ui.roleButton(page).click();
    await page.locator('header div[style*="width: 300px"] button', { hasText: 'Domain Owner' }).click();
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect(ui.nav(page, meta.label[0])).toHaveCount(0);
  });
});
