import { test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow } from '../helpers.js';

// The organisations of the operator console in the sample build (MILESTONE-2 M2-S12): the list with status, plan, users
// against the limit, the last day with the days left and the verified domains, its status filter and search; "Create
// organisation" with a plan preset; the organisation drawer with Overview, Status (the moves of J.8 with their
// effects, the reason and the slug typed again), Domains (the TXT record shown once with Copy, Verify now, the
// refusals, Remove), Entitlements (preset and custom limits, the over-limit warning, a first plan) and History; every
// tab and dialog in Indonesian, light and dark. The sample service holds the three organisations of the snapshot and
// PT Mitra Logistik Andalan (suspended) and PT Sinar Farma Sejahtera (offboarding); today is 29 Sep 2026.
// @sample-only: the API project runs e2e/api-only/ops-organizations.spec.js.
const meta = metaById('ops');
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });
const drawerTab = (page, label) => ui.drawer(page).getByRole('tab', { name: label, exact: true });
const row = (page, slug) => page.locator('main table tbody tr', { hasText: slug });

async function openOrganisations(page, query = '') {
  await openScreen(page, meta, query);
  await tab(page, /^(Organisations|Organisasi)$/).click();
  await expect(page.locator('main table tbody tr')).toHaveCount(5);
}

async function manage(page, slug, label = 'Manage') {
  await row(page, slug).getByRole('button', { name: label }).click();
  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawer(page).locator(`[data-org-drawer="${slug}"]`)).toBeVisible();
}

test.describe('Operator console organisations @sample-only', () => {
  test('the list shows status, plan, users of the limit, the last day with the days left and the verified domains; filter and search', async ({ page }) => {
    await openOrganisations(page);
    const main = page.locator('main');
    for (const header of ['Status', 'Plan', 'Users', 'Valid until', 'Licence', 'Verified domains']) await expect(main.locator('thead')).toContainText(header);
    await expect(row(page, 'ndt')).toContainText('Active');
    await expect(row(page, 'ndt')).toContainText('enterprise');
    await expect(row(page, 'ndt')).toContainText('86 of 100');
    await expect(row(page, 'ndt')).toContainText('31 Mar 2027');
    await expect(row(page, 'ndt')).toContainText('183 days left');
    await expect(row(page, 'ndt')).toContainText('nusantaradigital.co.id');
    await expect(row(page, 'bsd')).toContainText('Ended 14 days ago');
    await expect(row(page, 'bsd')).toContainText('Grace period');
    await expect(row(page, 'mitra_logistik')).toContainText('Suspended');
    await expect(row(page, 'mitra_logistik')).toContainText('12 days left');
    await expect(row(page, 'sinar_farma')).toContainText('Offboarding');
    await expect(row(page, 'sinar_farma')).toContainText('1 day left');
    await expectReadableText(page, 4.5);
    await expectNoHorizontalOverflow(page);
    const status = main.locator('select').first();
    await status.selectOption('suspended');
    await expect(main.locator('tbody tr')).toHaveCount(1);
    await expect(main.locator('tbody tr')).toContainText('PT Mitra Logistik Andalan');
    await status.selectOption('archived');
    await expect(main).toContainText('No organisation has this status.');
    await status.selectOption('');
    await main.locator('input[type="search"]').fill('farma');
    await expect(main.locator('tbody tr')).toHaveCount(1);
    await expect(main.locator('tbody tr')).toContainText('sinar_farma');
  });

  test('Create organisation offers the plan presets, starts on the first one and names the plan in the result', async ({ page }) => {
    await openOrganisations(page);
    await ui.pageAction(page, 'Create organisation').click();
    const dialog = ui.modal(page);
    const plan = dialog.locator('select').nth(1);
    await expect(plan).toHaveValue('trial');
    await expect(plan.locator('option')).toHaveText(['trial: users 10, systems 1, days 30', 'standard: users 50, systems 3, days 365', 'No plan yet: set the limits later in Entitlements']);
    await expectOverlayReadable(page);
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('klinik_pratama');
    await inputs.nth(1).fill('Klinik Pratama');
    await inputs.nth(3).fill('admin@klinikpratama.co.id');
    await inputs.nth(4).fill('Sari Dewi');
    await plan.selectOption('standard');
    await dialog.locator('button', { hasText: /^Create$/ }).click();
    await expect(dialog).toContainText('The standard plan applies from 2026-09-29 to 2027-09-28.');
    await expect(dialog).toContainText('The invitation was emailed to admin@klinikpratama.co.id.');
    await expect(dialog.locator('button', { hasText: 'Copy link' })).toHaveCount(0);
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(row(page, 'klinik_pratama')).toContainText('standard');
    await expect(row(page, 'klinik_pratama')).toContainText('0 of 50');
    await expect(row(page, 'klinik_pratama')).toContainText('28 Sep 2027');
  });

  test('Overview and Status: each move lists its effects, needs a reason, and the final two the slug; History lists them', async ({ page }) => {
    await openOrganisations(page);
    await manage(page, 'ndt');
    const drawer = ui.drawer(page);
    for (const text of ['PT Nusantara Digital Teknologi', 'Set by the operator', '86 of 100', '4 of 5', 'ndt.co.id', 'Pending', 'nusantaradigital.co.id', 'Verified', '29 Sep 2026']) {
      await expect(drawer).toContainText(text);
    }
    await expectOverlayReadable(page);
    await drawerTab(page, 'Status').click();
    await expect(drawer).toContainText('Members can use everything their roles allow.');
    await expect(drawer.getByRole('button', { name: 'Archive' })).toHaveCount(0);
    // Suspend: the effects, then a reason of 3 characters or more.
    await drawer.getByRole('button', { name: 'Suspend' }).click();
    const dialog = ui.modal(page);
    await expect(dialog).toContainText('Suspend: PT Nusantara Digital Teknologi');
    await expect(dialog).toContainText('Every session in this organisation ends at once. People keep their other organisations.');
    await expect(dialog).toContainText('The Tenant Admins get an email with the new status and your reason.');
    await expect(dialog.locator('input')).toHaveCount(0);
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(dialog).toContainText('Give a reason of at least 3 characters.');
    await dialog.locator('textarea').fill('Invoice of September unpaid after two reminders');
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toContainText('PT Nusantara Digital Teknologi is now Suspended');
    await expect(drawer).toContainText('Sessions ended: 29.');
    await expect(drawer).toContainText('Tenant Admins emailed: 2 of 2.');
    await expectToast(page, 'PT Nusantara Digital Teknologi is now Suspended');
    await expect(drawer.locator('[data-status-meaning="suspended"]')).toBeVisible();
    await expect(row(page, 'ndt')).toContainText('Suspended');
    // Reactivate, then Start offboarding with the slug typed again.
    await drawer.getByRole('button', { name: 'Reactivate' }).click();
    await dialog.locator('textarea').fill('Invoice of September paid');
    await dialog.getByRole('button', { name: 'Reactivate' }).click();
    await expect(drawer.locator('[data-status-meaning="active"]')).toBeVisible();
    await drawer.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog).toContainText('The read-only period is 30 days. Archive the organisation after it ends.');
    await expect(dialog).toContainText('Type the slug ndt to confirm');
    await dialog.locator('textarea').fill('Contract ends on 30 September 2026');
    await dialog.locator('input').fill('NDT');
    await dialog.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog).toContainText('This is not the slug ndt. Type it exactly.');
    await expectOverlayReadable(page);
    await dialog.locator('input').fill('ndt');
    await dialog.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toContainText('Sessions ended: 0.');
    await expect(drawer).toContainText('Offboarding since 29 Sep 2026. The read-only period of 30 days ends on 29 Oct 2026.');
    // Archive is final.
    await drawer.getByRole('button', { name: 'Archive' }).click();
    await expect(dialog).toContainText('This is final: an archived organisation cannot become active again.');
    await dialog.locator('textarea').fill('Read-only period over');
    await dialog.locator('input').fill('ndt');
    await dialog.getByRole('button', { name: 'Archive' }).click();
    await expect(drawer).toContainText('Archived is final. No move is possible.');
    await drawerTab(page, 'History').click();
    const history = drawer.locator('tbody tr');
    await expect(history).toHaveCount(6);
    await expect(history.nth(0)).toContainText('Read-only period over');
    await expect(history.nth(0)).toContainText('Offboarding');
    await expect(history.nth(0)).toContainText('Archived');
    await expect(history.nth(3)).toContainText('Invoice of September unpaid after two reminders');
    await expect(history.nth(5)).toContainText('Invoice of April unpaid after two reminders');
    await expectOverlayReadable(page);
    await drawerTab(page, 'Domains').click();
    await expect(drawer).toContainText('An archived organisation takes no new domains and its domains are not checked.');
    await expect(drawer.getByRole('button', { name: 'Add domain' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Verify now' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(ui.drawer(page)).toHaveCount(0);
    await expect(row(page, 'ndt')).toContainText('Archived');
  });

  test('Domains: the TXT record once with Copy, Verify now, the refusals in both languages, and Remove', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openOrganisations(page);
    await manage(page, 'rmn');
    const drawer = ui.drawer(page);
    await drawerTab(page, 'Domains').click();
    await expect(drawer).toContainText('No email domain yet.');
    await drawer.getByRole('button', { name: 'Add domain' }).click();
    const dialog = ui.modal(page);
    await expect(dialog).toContainText('Add an email domain to RS Medika Nusantara');
    await expectOverlayReadable(page);
    const input = dialog.locator('input');
    await input.fill('medika');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toHaveText('Enter a domain such as example.co.id.');
    await input.fill('gmail.com');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('gmail.com is a free mail domain that anyone can use');
    await input.fill('nusantaradigital.co.id');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('is already verified for another organisation');
    await input.fill('RS@Medika.co.id');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toContainText('The TXT record for medika.co.id');
    await expect(dialog).toContainText('This value is shown only once.');
    await expect(dialog).toContainText('_mscd-verify.medika.co.id');
    const value = (await dialog.locator('[data-domain-record] code').nth(2).textContent()).trim();
    expect(value).toMatch(/^mscd-verify=[A-Za-z0-9_-]{43}$/);
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Copy' }).nth(1).click();
    await expectToast(page, 'Record value copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    // The value is not kept in the page once the dialog closes (GL-50).
    expect(await page.content()).not.toContain(value.slice(12));
    await drawer.getByRole('button', { name: 'Add domain' }).click();
    await expect(dialog.locator('input')).toHaveValue('');
    await page.keyboard.press('Escape');
    const domain = drawer.locator('[data-domain="medika.co.id"]');
    await expect(domain).toContainText('Pending');
    await expect(domain).toContainText('Not checked yet');
    await domain.getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText('The record of medika.co.id was not found yet.');
    await domain.getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText('The record of medika.co.id was found. The domain is verified.');
    await expect(domain).toContainText('Verified');
    await expect(row(page, 'rmn')).toContainText('medika.co.id');
    await domain.getByRole('button', { name: 'Remove' }).click();
    await expect(dialog).toContainText('Remove the domain medika.co.id?');
    await expect(dialog).toContainText('People with email addresses at medika.co.id no longer find RS Medika Nusantara');
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Domain medika.co.id removed');
    await expect(drawer).toContainText('No email domain yet.');
    // A domain verified by the operator command has nothing to check; a failed one says to add it again.
    await page.keyboard.press('Escape');
    await manage(page, 'bsd');
    await drawerTab(page, 'Domains').click();
    await expect(drawer.locator('[data-domain="banksentosa.co.id"]')).toContainText('By the operator command');
    await expect(drawer.locator('[data-domain="banksentosa.co.id"]').getByRole('button', { name: 'Verify now' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await manage(page, 'mitra_logistik');
    await drawerTab(page, 'Domains').click();
    const failed = drawer.locator('[data-domain="mitralogistik.co.id"]');
    await expect(failed).toContainText('Not found within 7 days. Add the domain again for a new value.');
    await failed.getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText('the 7 days have ended');
  });

  test('Entitlements: custom limits with the over-limit warning, a preset, and the first plan of a new organisation', async ({ page }) => {
    await openOrganisations(page);
    await manage(page, 'ndt');
    const drawer = ui.drawer(page);
    await drawerTab(page, 'Entitlements').click();
    const form = drawer.locator('[data-entitlement-form]');
    await expect(drawer.locator('[data-entitlement-version="3"]')).toContainText('86 of 100');
    await expect(form.locator('select')).toHaveValue('');
    await expectOverlayReadable(page);
    const users = form.getByLabel('Users');
    await users.fill('-1');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(form).toContainText('Enter a whole number of 0 or more.');
    await users.fill('50');
    await form.getByLabel('Management systems').fill('3');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer).toContainText('Saved with a warning');
    await expect(drawer).toContainText('The organisation has 86 active members and the new limit is 50.');
    await expect(drawer).toContainText('The organisation has 4 management systems and the new limit is 3.');
    await expect(drawer.locator('[data-entitlement-version="4"]')).toContainText('86 of 50');
    await expectToast(page, 'Entitlement of PT Nusantara Digital Teknologi saved');
    await expect(row(page, 'ndt')).toContainText('86 of 50');
    await expectOverlayReadable(page);
    // A preset sets every limit and starts today (the sample's day), not on the first day of the current plan; the
    // last day follows from the first.
    await form.locator('select').selectOption('standard');
    await expect(form.getByLabel('Users')).toHaveCount(0);
    await expect(form.locator('input[type="date"]')).toHaveValue('2026-09-29');
    await expect(form).toContainText('The preset runs until 28 Sep 2027.');
    await form.locator('input[type="date"]').fill('2026-10-01');
    await expect(form).toContainText('The preset runs until 30 Sep 2027.');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer.locator('[data-entitlement-version="5"]')).toContainText('Plan preset');
    await expect(drawer.locator('[data-entitlement-version="5"]')).toContainText('From 1 Oct 2026 until 30 Sep 2027');
    await expect(row(page, 'ndt')).toContainText('standard');
    // No end date.
    await form.getByLabel('No end date').check();
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer.locator('[data-entitlement-version="6"]')).toContainText('From 1 Oct 2026, no end date');
    await page.keyboard.press('Escape');
    await expect(row(page, 'ndt')).toContainText('No end date');
    // A new organisation without a plan: the form starts on the first preset (If-Match *).
    await ui.pageAction(page, 'Create organisation').click();
    const dialog = ui.modal(page);
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('klinik_baru');
    await inputs.nth(1).fill('Klinik Baru');
    await inputs.nth(3).fill('admin@klinikbaru.co.id');
    await inputs.nth(4).fill('Andi Wijaya');
    await dialog.locator('select').nth(1).selectOption('');
    await dialog.locator('button', { hasText: /^Create$/ }).click();
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(row(page, 'klinik_baru')).toContainText('No plan');
    await manage(page, 'klinik_baru');
    await drawerTab(page, 'Entitlements').click();
    await expect(drawer).toContainText('No plan yet');
    await expect(form.locator('select')).toHaveValue('trial');
    await expect(form).toContainText('The preset runs until 28 Oct 2026.');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer.locator('[data-entitlement-version="1"]')).toContainText('0 of 10');
    await expect(row(page, 'klinik_baru')).toContainText('trial');
  });

  for (const theme of ['light', 'dark']) {
    test(`every tab and dialog of the drawer is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openOrganisations(page, `lang=id&theme=${theme}`);
      await expectReadableText(page, 4.5);
      await manage(page, 'sinar_farma', 'Kelola');
      const drawer = ui.drawer(page);
      const dialog = ui.modal(page);
      for (const label of ['Ringkasan', 'Status', 'Domain', 'Hak pakai', 'Riwayat']) {
        await drawerTab(page, label).click();
        await expect(drawer.locator('[role="tabpanel"]')).not.toContainText('Memuat');
        await page.waitForTimeout(300);
        await expectOverlayReadable(page);
      }
      await drawerTab(page, 'Status').click();
      await expect(drawer).toContainText('Pengakhiran sejak 19 Sep 2026. Masa hanya baca 30 hari berakhir pada 19 Okt 2026.');
      await drawer.getByRole('button', { name: 'Arsipkan' }).click();
      await expect(dialog).toContainText('Ketik slug sinar_farma untuk mengonfirmasi');
      await dialog.getByRole('button', { name: 'Arsipkan' }).click();
      await expect(dialog).toContainText('Berikan alasan paling sedikit 3 karakter.');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await drawerTab(page, 'Domain').click();
      await drawer.getByRole('button', { name: 'Tambah domain' }).click();
      await expectOverlayReadable(page);
      await dialog.locator('input').fill('sinarfarma-group.co.id');
      await dialog.getByRole('button', { name: 'Tambah', exact: true }).click();
      await expect(dialog).toContainText('Nilai ini hanya ditampilkan sekali.');
      await expectOverlayReadable(page);
      await dialog.getByRole('button', { name: 'Selesai' }).click();
      await drawer.locator('[data-domain="sinarfarma-group.co.id"]').getByRole('button', { name: 'Hapus' }).click();
      await expectOverlayReadable(page);
      await dialog.getByRole('button', { name: 'Batal' }).click();
      await drawerTab(page, 'Hak pakai').click();
      await drawer.locator('[data-entitlement-form] select').selectOption('trial');
      await expect(drawer).toContainText('Preset berlaku sampai');
      await expectOverlayReadable(page);
    });
  }
});
