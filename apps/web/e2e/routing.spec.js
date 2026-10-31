import { test, expect, openApp, go, ui, switchMs } from './helpers.js';
import { DEMO_PASSWORD, EMAILS, demoCode, freshTotpStep } from '../e2e-api/fixtures.js';

// Screen addresses (MILESTONE-2 M2-20). Every screen has an address: its id as the path (API build) or in the hash
// (sample build), with the system, the organisation of a person in several and the tab of a host screen as query
// values. A refresh opens the same place, Back and Forward move between screens, an address the person cannot open
// opens the start screen, and a copied address opens the same place after sign-in. The tests run in both projects
// unless tagged: the sample manager and the api's rina are both members of several organisations.

const api = () => test.info().project.use.dataSource === 'api';

/** The place the address names: the screen path and the route values, from the path (API) or the hash (sample). */
function placeOf(page) {
  const u = new URL(page.url());
  const [path, query = ''] = api() ? [u.pathname, u.search.slice(1)] : u.hash.replace(/^#/, '').split('?');
  const values = Object.fromEntries(new URLSearchParams(query));
  return { screen: path.replace(/^\//, ''), ms: values.ms ?? null, org: values.org ?? null, tab: values.tab ?? null, persona: values.persona ?? null };
}
async function expectPlace(page, screen, values = {}) {
  await expect.poll(() => placeOf(page)).toEqual({ screen, ms: null, org: null, tab: null, persona: null, ...values });
}
/** An address of the app in the form of the build: `/controls?ms=qms` or `/#/controls?ms=qms`. */
const address = (place) => (api() ? place : '/#' + place);
const tabButton = (page, name) => page.getByRole('tab', { name: new RegExp('^' + name) });

test.describe('Screen addresses', () => {
  test('every screen has an address: the screen, its system and the organisation', async ({ page }) => {
    await openApp(page);
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expectPlace(page, 'portfolio', { ms: 'isms', org: 'ndt' });
    await go(page, 'Controls & requirements');
    await expectPlace(page, 'controls', { ms: 'isms', org: 'ndt' });
    await switchMs(page, 'QMS');
    await expectPlace(page, 'controls', { ms: 'qms', org: 'ndt' });
    await go(page, 'Findings and actions');
    await tabButton(page, 'Corrective actions').click();
    await expectPlace(page, 'findings', { ms: 'qms', org: 'ndt', tab: 'actions' });
  });

  test('a refresh keeps the screen, the system and the tab', async ({ page }) => {
    await openApp(page);
    await switchMs(page, 'QMS');
    await go(page, 'Registers');
    await tabButton(page, 'Risks').click();
    await expect(tabButton(page, 'Risks')).toHaveAttribute('aria-selected', 'true');
    await expectPlace(page, 'registers', { ms: 'qms', org: 'ndt', tab: 'risks' });
    await page.reload();
    await expect(ui.title(page)).toHaveText('Registers');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect(tabButton(page, 'Risks')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('main [data-register="risks"]')).toBeVisible();
    await expectPlace(page, 'registers', { ms: 'qms', org: 'ndt', tab: 'risks' });
  });

  test('Back and Forward move between screens; a change of system or tab replaces the entry', async ({ page }) => {
    await openApp(page);
    await go(page, 'Controls & requirements');
    await switchMs(page, 'QMS');
    await go(page, 'Findings and actions');
    await tabButton(page, 'Corrective actions').click();
    await expectPlace(page, 'findings', { ms: 'qms', org: 'ndt', tab: 'actions' });

    await page.goBack();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expectPlace(page, 'controls', { ms: 'qms', org: 'ndt' });
    await page.goBack();
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expectPlace(page, 'portfolio', { ms: 'isms', org: 'ndt' });

    await page.goForward();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await page.goForward();
    await expect(ui.title(page)).toHaveText('Findings and actions');
    await expect(tabButton(page, 'Corrective actions')).toHaveAttribute('aria-selected', 'true');
    await expectPlace(page, 'findings', { ms: 'qms', org: 'ndt', tab: 'actions' });
  });

  test('an address of a screen the person cannot open, or of an unknown screen, opens the start screen and is corrected', async ({ page }) => {
    // The sample's Domain Owner has no Licence; the api's rina is no platform operator, so the operator console is closed.
    await page.goto(api() ? '/ops?tab=orgs' : '/#/license?persona=owner');
    await expect(ui.title(page)).toHaveText(api() ? 'Portfolio Overview' : 'My Tasks');
    await expectPlace(page, api() ? 'portfolio' : 'mytasks', { ms: 'isms', org: 'ndt', ...(api() ? {} : { persona: 'owner' }) });
    await page.goto(address('/nothing?ms=zzz'));
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expectPlace(page, 'portfolio', { ms: 'isms', org: 'ndt' });
    // A tab the screen does not have: the first tab, and the address loses it.
    await page.goto(address('/registers?ms=isms&tab=nothing'));
    await expect(ui.title(page)).toHaveText('Registers');
    await expect(tabButton(page, 'Context issues')).toHaveAttribute('aria-selected', 'true');
    await expectPlace(page, 'registers', { ms: 'isms', org: 'ndt' });
  });

  test('a path with a folder part is tidied before the app renders, so the sidebar logo loads', { tag: '@api-only' }, async ({ page }) => {
    // The generated sidebar loads its logo with a relative path; from /controls/ it would ask for /controls/assets/...
    const logoLoads = () => page.locator('img[alt="CyberLentera"]').first().evaluate((img) => img.complete && img.naturalWidth > 0);
    await page.goto('/controls/?ms=qms');
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expectPlace(page, 'controls', { ms: 'qms', org: 'ndt' });
    await expect.poll(logoLoads).toBe(true);
    // A path deeper than a screen names no screen: the start screen, with the values of the address.
    await page.goto('/controls/x/?ms=qms');
    await expect(ui.title(page)).toHaveText('Portfolio Overview');
    await expectPlace(page, 'portfolio', { ms: 'qms', org: 'ndt' });
    await expect.poll(logoLoads).toBe(true);
  });

  test('an address names the organisation and opens it', async ({ page }) => {
    await page.goto(address('/controls?ms=qms&org=bsd'));
    await expect(ui.orgButton(page)).toContainText('PT Bank Sentosa Digital');
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expectPlace(page, 'controls', { ms: 'qms', org: 'bsd' });
  });
});

test.describe('Screen addresses of the sample build', () => {
  test('the sample build keeps the path of its file and works with the hash', { tag: '@sample-only' }, async ({ page }) => {
    // Every page load asks for the app's own file: the sample build needs no server that knows its addresses.
    const loads = [];
    page.on('request', (r) => { if (r.isNavigationRequest()) loads.push(new URL(r.url()).pathname); });
    await page.goto('/?lang=id#/controls?ms=qms');
    await expect(ui.title(page)).toHaveText('Kontrol & persyaratan');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect.poll(() => page.url()).toMatch(/\/\?lang=id#\/controls\?ms=qms&org=ndt$/);

    // A hash typed in the address bar opens its place without loading the page again.
    await page.evaluate(() => { window.__kept = true; });
    await page.goto('/?lang=id#/docs?ms=isms&org=ndt');
    await expect(ui.title(page)).toHaveText('Register dokumen');
    await expect(ui.msSwitch(page)).toContainText('ISMS');
    expect(await page.evaluate(() => window.__kept)).toBe(true);
    await page.goBack();
    await expect(ui.title(page)).toHaveText('Kontrol & persyaratan');

    // The start query of the sample build (?screen=<id>&persona=<role>) still works and becomes a hash address.
    await page.goto('/?screen=license&persona=top');
    await expect(ui.title(page)).toHaveText('Licence');
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expectPlace(page, 'license', { ms: 'isms', org: 'ndt', persona: 'top' });
    await page.reload();
    await expect(ui.title(page)).toHaveText('Licence');
    await expect(ui.roleButton(page)).toContainText('Top Management');
    expect(loads.every((p) => p === '/')).toBe(true);
  });
});

test.describe('The start screen of an API session @api-only', () => {
  // The first screen follows the landing of the role, as a persona switch lands (product owner, 2026-10-31).
  test.use({ apiSession: 'bagus' });

  test('a Domain Owner opens My Tasks, and a refresh keeps it', async ({ page }) => {
    await openApp(page);
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect.poll(() => placeOf(page).screen).toBe('mytasks');
    await page.reload();
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect.poll(() => placeOf(page).screen).toBe('mytasks');
  });
});

test.describe('Screen addresses and sign-in @api-only', () => {
  test.use({ apiSession: null });

  test('a copied address opens the same place after sign-in', async ({ page }) => {
    await freshTotpStep();
    await page.goto('/registers?ms=qms&org=bsd&tab=risks');
    await expect(page).toHaveURL(/\/login\?org=bsd$/);
    await page.getByLabel('Work email').fill(EMAILS.rina);
    await page.locator('#au-password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await page.getByLabel('Authentication code').fill(demoCode('rina'));
    await expect(ui.title(page)).toHaveText('Registers');
    await expect(ui.orgButton(page)).toContainText('PT Bank Sentosa Digital');
    await expect(ui.msSwitch(page)).toContainText('QMS');
    await expect(tabButton(page, 'Risks')).toHaveAttribute('aria-selected', 'true');
    await expectPlace(page, 'registers', { ms: 'qms', org: 'bsd', tab: 'risks' });
  });
});

test('the operator console keeps its section in the address', { tag: '@sample-only' }, async ({ page }) => {
  await openApp(page);
  await go(page, 'Operator console');
  await page.getByRole('tab', { name: /^Organisations/ }).click();
  await expectPlace(page, 'ops', { ms: 'isms', org: 'ndt', tab: 'orgs' });
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Organisations/ })).toHaveAttribute('aria-selected', 'true');
});
