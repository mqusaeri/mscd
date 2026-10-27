import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // C.2: ?persona= sets the persona and its rules; a host screen that persona does not list is not opened, its body
  // and data stay hidden, and the persona lands on its own first screen.
  const LANDING = { manager: 'Portfolio Overview', owner: 'My Tasks', auditor: 'Portfolio Overview', top: 'Portfolio Overview' };
  for (const meta of HOST_METAS) {
    const persona = Object.keys(LANDING).find((p) => !meta.roles.includes(p));
    if (!persona) continue;
    test(`?screen=${meta.id}&persona=${persona} keeps that persona on its landing`, async ({ page }) => {
      await page.goto(`/?screen=${encodeURIComponent(meta.id)}&persona=${persona}`);
      await expect(ui.title(page)).toHaveText(LANDING[persona]);
      await expect(page.locator(`main [data-screen="${meta.id}"]`)).toHaveCount(0);
      await expect(ui.nav(page, meta.label[0])).toHaveCount(0);
      await expect(ui.navItems(page)).toHaveCount(await navFor(page, persona));
    });
  }

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

// The form helper of the screens (screens/api.ts useMutation, C.6) in a development build: React StrictMode mounts
// every component, unmounts it and mounts it again, and the form must still leave Save usable after each answer.
// The fixture is bundled with React's development build and runs on a blank page, outside the app.
const STRICT_FORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/screens/strict-form.tsx');

/** Bundles the fixture into one script with Vite, a declared dev dependency of the web workspace. */
async function bundleStrictForm() {
  const { build } = await import('vite');
  const nodeEnv = process.env.NODE_ENV;
  try {
    const out = await build({
      configFile: false, root: path.dirname(STRICT_FORM), mode: 'development', logLevel: 'silent', publicDir: false,
      define: { 'process.env.NODE_ENV': '"development"' }, esbuild: { jsx: 'automatic', jsxDev: false },
      build: { write: false, minify: false, target: 'es2020', lib: { entry: STRICT_FORM, formats: ['iife'], name: 'StrictForm' } },
    });
    return (Array.isArray(out) ? out[0] : out).output[0].code;
  } finally {
    // Vite sets NODE_ENV for the process when it is unset; the worker keeps its own value.
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

test.describe('Screen helpers under StrictMode @sample-only', () => {
  test('useMutation shows the field error of a refused save, then allows a second save', async ({ page }) => {
    await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: await bundleStrictForm() });
    const save = page.locator('button', { hasText: 'Save' });
    await save.click();
    await expect(page.locator('[role="alert"]')).toHaveText('Name is too short');
    await expect(page.getByTestId('state')).toHaveText('idle');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('done')).toHaveText('Saved Risk register');
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await expect(save).toBeEnabled();
  });
});
