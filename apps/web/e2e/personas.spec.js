import {
  test, expect, openApp, ui, tab, switchRole, navFor, HOST_METAS, BUILTIN_IDS, BUILTIN_SCREENS, go, openRow, listRow, listRows, list, drawerAction,
  expectToast, expectOverlayReadable, switchMs, chip, search,
} from './helpers.js';

// The demo personas (MILESTONE-3 E, H.10): the four of the sample and the Programme Owner Wulan Hartono, the Risk
// Owner Ratna Kusumawati and the Compliance Investigator Gilang Saputra. Each persona opens on the landing of its role
// with the sidebar of its role: the Programme Owner sees the built-in screens of a Management System Manager, the Risk
// Owner and the Compliance Investigator those of a Domain Owner, and every persona the host screens its role opens
// (sample: the `roles` of each screen's meta.json; api: the F.6 permissions in the session's `Me`). A persona switch
// keeps the address of the screen (MILESTONE-2 M2-20). The API tests sign in as the new personas through `apiSession`.

const api = () => test.info().project.use.dataSource === 'api';

const PERSONAS = [
  { role: 'manager', handle: 'rina', name: 'Rina Kusuma', label: 'Management System Manager', base: 'manager', landing: 'Portfolio Overview' },
  { role: 'owner', handle: 'bagus', name: 'Bagus Prasetyo', label: 'Domain Owner', base: 'owner', landing: 'My Tasks' },
  { role: 'auditor', handle: 'maya', name: 'Maya Putri', label: 'Internal Auditor', base: 'auditor', landing: 'Portfolio Overview' },
  { role: 'top', handle: 'hendra', name: 'Hendra Wijaya', label: 'Top Management', base: 'top', landing: 'Portfolio Overview' },
  { role: 'sponsor', handle: 'wulan', name: 'Wulan Hartono', label: 'Programme Owner', base: 'manager', landing: 'Portfolio Overview' },
  { role: 'riskowner', handle: 'ratna', name: 'Ratna Kusumawati', label: 'Risk Owner', base: 'owner', landing: 'My Tasks' },
  { role: 'investigator', handle: 'gilang', name: 'Gilang Saputra', label: 'Compliance Investigator', base: 'owner', landing: 'My Tasks' },
];
const NEW_PERSONAS = PERSONAS.filter((p) => ['sponsor', 'riskowner', 'investigator'].includes(p.role));

// Built-in screens of each base persona (visFor of the controller); null means every one of them.
const BUILTIN_VIS = {
  manager: null,
  owner: ['mytasks', 'm1overview', 'controls', 'docs', 'fresh'],
  auditor: ['portfolio', 'audit', 'chain', 'gt', 'docs', 'controls', 'fresh', 'timeline', 'mytasks'],
  top: ['portfolio', 'm1overview', 'timeline', 'audit', 'chain', 'mytasks'],
};

/** The sidebar of a sample persona in an organisation with several systems: built-in screens of its base persona, then its host screens. */
function sampleSidebar(persona) {
  const vis = BUILTIN_VIS[persona.base];
  const builtin = BUILTIN_IDS.filter((id) => !vis || vis.includes(id)).map((id) => BUILTIN_SCREENS[BUILTIN_IDS.indexOf(id)]);
  const hosts = HOST_METAS.filter((m) => m.nav !== false && m.roles.includes(persona.role)).map((m) => m.label[0]);
  return [...builtin, ...hosts].sort();
}

/** The titles of the sidebar entries, sorted. */
const sidebar = (page) => ui.navItems(page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute('title')).sort());

/** The place the address names (MILESTONE-2 M2-20): the screen path and the route values, from the path (API) or the hash (sample). */
function placeOf(page) {
  const u = new URL(page.url());
  const [path, query = ''] = api() ? [u.pathname, u.search.slice(1)] : u.hash.replace(/^#/, '').split('?');
  const values = Object.fromEntries(new URLSearchParams(query));
  return { screen: path.replace(/^\//, ''), ms: values.ms ?? null, org: values.org ?? null, tab: values.tab ?? null, persona: values.persona ?? null };
}
async function expectPlace(page, screen, values = {}) {
  await expect.poll(() => placeOf(page)).toEqual({ screen, ms: null, org: null, tab: null, persona: null, ...values });
}
/** The sample build carries a persona other than the manager in its address; the API build never does. */
const personaOf = (role) => (api() || role === 'manager' ? {} : { persona: role });

test.describe('The seven sample personas @sample-only', () => {
  for (const persona of PERSONAS) {
    test(`${persona.label} opens on its landing with the sidebar of its role`, async ({ page }) => {
      await openApp(page, persona.role === 'manager' ? '' : `?persona=${persona.role}`);
      await expect(ui.title(page)).toHaveText(persona.landing);
      await expect(ui.roleButton(page)).toContainText(persona.name);
      await expect(ui.roleButton(page)).toContainText(persona.label);
      await expect.poll(() => sidebar(page)).toEqual(sampleSidebar(persona));
      await expectPlace(page, persona.landing === 'My Tasks' ? 'mytasks' : 'portfolio', { ms: 'isms', org: 'ndt', ...personaOf(persona.role) });
    });
  }

  test('the persona menu lists the seven personas with their names and labels', async ({ page }) => {
    await openApp(page);
    await ui.roleButton(page).click();
    const menu = page.locator('header div[style*="width: 300px"] button');
    await expect(menu).toHaveCount(PERSONAS.length);
    for (const [i, persona] of PERSONAS.entries()) {
      await expect(menu.nth(i)).toContainText(persona.name);
      await expect(menu.nth(i)).toContainText(persona.label);
    }
  });

  test('a Risk Owner and a Compliance Investigator see only their own records, a Programme Owner every record', async ({ page }) => {
    // In the sample the ABMS due diligence requirement 8.2 belongs to Gilang Saputra, and no ISMS control to Ratna Kusumawati.
    await openApp(page, '#/controls?ms=isms');
    const all = (await tab(page, 'Controls implemented').innerText()).replace(/\s+/g, ' ');
    expect(all).toMatch(/of [1-9]\d+/);
    await openApp(page, '#/controls?ms=abms&persona=investigator');
    await expect(ui.roleButton(page)).toContainText('Compliance Investigator');
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.msSwitch(page)).toContainText('ABMS');
    await expect(tab(page, 'Requirements implemented')).toContainText(/of 1(?!\d)/);
    await openApp(page, '#/controls?ms=isms&persona=riskowner');
    await expect(ui.roleButton(page)).toContainText('Risk Owner');
    await expect(ui.msSwitch(page)).toContainText('ISMS');
    await expect(tab(page, 'Controls implemented')).toContainText(/of 0(?!\d)/);
    await openApp(page, '#/controls?ms=isms&persona=sponsor');
    await expect(ui.roleButton(page)).toContainText('Programme Owner');
    await expect.poll(async () => (await tab(page, 'Controls implemented').innerText()).replace(/\s+/g, ' ')).toBe(all);
  });
});

test.describe('The sample checks of host screens follow the base persona @sample-only', () => {
  const dialog = (page) => ui.modal(page).last();
  const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^${name}$`) });
  const registerTab = (page, name) => page.locator('main [role="tab"]', { hasText: new RegExp(`^${name}$`) });

  test('the Programme Owner approves the review of PLN-02 and rejects an entry that waits for verification', async ({ page }) => {
    // F.6 gives the Programme Owner `document.approve` and `applicability.verify` in full, as the API build does.
    await openApp(page, '?persona=sponsor');
    await expect(ui.roleButton(page)).toContainText('Wulan Hartono');
    await go(page, 'Document register');
    await openRow(page, 'PLN-02');
    await drawerAction(page, 'Open review').click();
    await expect(dialog(page)).toContainText('Review of PLN-02');
    await expect(dialog(page)).not.toContainText('Only a Management System Manager or a Programme Owner approves documents');
    await expect(button(dialog(page), 'Return to draft')).toBeVisible();
    await expect(button(dialog(page), 'Approve')).toBeEnabled();
    await expectOverlayReadable(page);
    await button(dialog(page), 'Approve').click();
    await expectToast(page, 'PLN-02 approved');
    await expect(ui.modal(page)).toHaveCount(0);
    await expect(listRow(page, 'PLN-02')).toContainText('Approved');

    await go(page, 'Controls & requirements');
    await switchMs(page, 'QMS');
    await chip(page, 'All').click();
    await search(page, 'Cl. 8.7');
    await openRow(page, 'Cl. 8.7');
    await expect(ui.drawer(page)).toContainText('Complete, awaiting verification');
    const entry = ui.drawer(page).locator('[data-m11="entry"]');
    await button(entry, 'Reject').click();
    await expect(dialog(page)).toContainText('The entry goes back to Partially implemented.');
    await dialog(page).locator('textarea').fill('The calibration log misses September.');
    await expectOverlayReadable(page);
    await button(dialog(page), 'Reject').click();
    await expectToast(page, 'Cl. 8.7 returned to Partially implemented');
    await expect(listRow(page, 'Cl. 8.7')).toContainText('Partial');
  });

  test('the Risk Owner and the Compliance Investigator read their own register rows, the Programme Owner every row', async ({ page }) => {
    // In the sample no ISMS risk belongs to Ratna Kusumawati or Gilang Saputra; R-014 is Bagus Prasetyo's.
    for (const role of ['riskowner', 'investigator']) {
      await page.goto(`/?screen=registers&persona=${role}`);
      await expect(page.locator('main h1')).toHaveText('Registers');
      // The Risk Owner adds records of her own (`register.manage`, own rows, F.6); the Compliance Investigator holds no such grant.
      if (role === 'riskowner') await expect(ui.pageAction(page, 'Add record')).toBeVisible();
      else await expect(ui.pageAction(page, 'Add record')).toHaveCount(0);
      await registerTab(page, 'Risks').click();
      await expect(page.locator('main [data-screen="registers"]')).toContainText('Nothing in this register yet');
      await expect(page.locator('main')).not.toContainText('R-014');
    }
    await page.goto('/?screen=registers&persona=sponsor');
    await expect(ui.roleButton(page)).toContainText('Programme Owner');
    await registerTab(page, 'Risks').click();
    await expect(list(page)).toContainText('Showing 6 of 6 items');
    await expect(listRow(page, 'R-014')).toContainText('Bagus Prasetyo');
    await registerTab(page, 'Competence').click();
    await expect(listRows(page)).toHaveCount(3);
  });
});

test.describe('The new personas against the api @api-only', () => {
  for (const persona of NEW_PERSONAS) {
    test.describe(persona.label, () => {
      test.use({ apiSession: persona.handle });

      test(`${persona.name} opens on the landing of a ${persona.base === 'manager' ? 'Management System Manager' : 'Domain Owner'} with the sidebar of the role`, async ({ page }) => {
        await openApp(page);
        await expect(ui.title(page)).toHaveText(persona.landing);
        await expect(ui.roleButton(page)).toContainText(persona.name);
        await expect(ui.roleButton(page)).toContainText(persona.label);
        // The built-in screens of the base persona and the host screens the F.6 permissions of the role open.
        await expect(ui.navItems(page)).toHaveCount(await navFor(page, persona.base));
        const me = await (await page.request.get('/api/v1/me')).json();
        expect(Object.values(me.uiRoleByMs)).toContain(persona.role);
        if (persona.base === 'manager') {
          await expect(ui.nav(page, 'Phase board')).toBeVisible();
          await expect(ui.nav(page, 'Retention and disposal')).toBeVisible();
          await expect(ui.nav(page, 'People and roles')).toHaveCount(0);
        } else {
          await expect(ui.nav(page, 'Chain stages')).toHaveCount(0);
          await expect(ui.nav(page, 'Retention and disposal')).toHaveCount(0);
        }
      });
    });
  }

  test.describe('Policies to confirm from My Tasks', () => {
    test.use({ apiSession: null });

    test('ratna opens the read confirmation of RS Medika Nusantara from My Tasks', async ({ page, baseURL }) => {
      await page.context().clearCookies();
      const res = await page.request.post(`${baseURL}/api/v1/test/session`, { data: { handle: 'ratna', org: 'rmn' }, headers: { origin: baseURL } });
      expect(res.ok(), await res.text()).toBe(true);
      await openApp(page);
      await expect(ui.title(page)).toHaveText('My Tasks');
      const row = page.locator('main div[style*="grid-template-columns: 4px 44px"]').filter({ hasText: 'Read and confirm POL-01' });
      await expect(row).toContainText('Finish it in Policies to confirm.');
      await expect(row.locator('button', { hasText: 'Mark done' })).toHaveCount(0);
      await row.locator('button', { hasText: /^Open$/ }).click();
      await expect(ui.title(page)).toHaveText('Policies to confirm');
      await expect(page.locator('main [data-screen="my-confirmations"]')).toContainText('POL-01');
      await expectPlace(page, 'my-confirmations', { ms: 'isms', org: 'rmn' });
    });
  });
});

test.describe('Persona switching keeps the address', () => {
  test('a switch to the Programme Owner keeps the screen; one to the Risk Owner or the Compliance Investigator lands on My Tasks', async ({ page }) => {
    await openApp(page, api() ? 'controls?ms=isms' : '#/controls?ms=isms');
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expectPlace(page, 'controls', { ms: 'isms', org: 'ndt' });

    await switchRole(page, 'Programme Owner');
    await expect(ui.roleButton(page)).toContainText('Wulan Hartono');
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expectPlace(page, 'controls', { ms: 'isms', org: 'ndt', ...personaOf('sponsor') });
    await page.reload();
    await expect(ui.title(page)).toHaveText('Controls & requirements');
    await expect(ui.roleButton(page)).toContainText('Programme Owner');
    await expectPlace(page, 'controls', { ms: 'isms', org: 'ndt', ...personaOf('sponsor') });

    await switchRole(page, 'Risk Owner');
    await expect(ui.roleButton(page)).toContainText('Ratna Kusumawati');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expectPlace(page, 'mytasks', { ms: 'isms', org: 'ndt', ...personaOf('riskowner') });
    await page.reload();
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect(ui.roleButton(page)).toContainText('Risk Owner');

    // In the demo stack the Compliance Investigator holds a role in the ABMS only, so the system follows the role there.
    await switchRole(page, 'Compliance Investigator');
    await expect(ui.roleButton(page)).toContainText('Gilang Saputra');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expectPlace(page, 'mytasks', { ms: api() ? 'abms' : 'isms', org: 'ndt', ...personaOf('investigator') });

    await switchRole(page, 'Management System Manager');
    await expect(ui.roleButton(page)).toContainText('Rina Kusuma');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expectPlace(page, 'mytasks', { ms: api() ? 'abms' : 'isms', org: 'ndt' });
  });
});
