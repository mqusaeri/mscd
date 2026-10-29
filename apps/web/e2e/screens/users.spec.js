import { readFile } from 'node:fs/promises';
import {
  test, expect, ui, openScreen, metaById, expectToast, expectOverlayReadable, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow,
} from '../helpers.js';

// People and roles of the sample build (MILESTONE-2 M2-10): the members of the sample organisation with their
// administration roles and their roles per management system, search and filters, the drawer per person, Invite
// person, Edit, Grant role with the four-eyes note (D2-12), Revoke role and Disable with the open items held, the
// withdrawal of a waiting grant, and the roles and responsibilities CSV. The sample persona is Rina Kusuma, a Tenant Admin. @sample-only: the API project
// covers the screen in e2e/api-only/users.spec.js.
const meta = metaById('users');
const drawer = (page) => ui.drawer(page);
const dialog = (page) => ui.modal(page);
const rows = (page) => page.locator('main table tbody tr');
const row = (page, text) => rows(page).filter({ hasText: text }).first();
const field = (page, name) => dialog(page).locator(`[name="${name}"]`);

async function openPerson(page, name) {
  await row(page, name).click();
  await expect(drawer(page)).toContainText(name);
}

test.describe('People and roles @sample-only', () => {
  test('lists the members with their roles, searches and filters them', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('People and roles');
    await expect(main).toContainText('2 role grants are waiting for the approval of a second Tenant Admin.');
    await expect(rows(page)).toHaveCount(12);
    await expect(row(page, 'Sari Wulandari')).toContainText('Management System Manager in QMS, primary');
    await expect(row(page, 'Rina Kusuma')).toContainText('You');
    await expect(row(page, 'Rina Kusuma')).toContainText('Tenant Admin');
    await expect(row(page, 'Yusuf Rahman')).toContainText('Risk Owner in ISMS');
    await expect(row(page, 'Yusuf Rahman')).toContainText('waiting for approval');
    await expect(row(page, 'nadia.halim@nusantaradigital.co.id')).toContainText('Invited');
    await expect(row(page, 'Fajar Nugroho')).toContainText('Not set up');
    await main.locator('input[name="q"]').fill('maya');
    await expect(rows(page)).toHaveCount(1);
    await main.locator('input[name="q"]').fill('');
    await main.locator('select[name="role"]').selectOption({ label: 'Administrators' });
    await expect(rows(page)).toHaveCount(3);
    await main.locator('select[name="role"]').selectOption({ label: 'Internal Auditor' });
    await main.locator('select[name="ms"]').selectOption({ label: 'QMS' });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Maya Putri');
    await expect(main).toContainText('1 of 12 people');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('Invite person checks the form and adds an invited member', async ({ page }) => {
    await openScreen(page, meta);
    await ui.pageAction(page, 'Invite person').click();
    await expect(dialog(page)).toContainText('Invite a person');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Send invitation' }).click();
    await expect(dialog(page)).toContainText('Enter a valid email address.');
    await field(page, 'email').fill('wulan.sari@nusantaradigital.co.id');
    await field(page, 'displayName').fill('Wulan Sari');
    await field(page, 'jobTitle').fill('Quality Analyst');
    await dialog(page).getByLabel('Storage Admin').check();
    await dialog(page).locator('button', { hasText: 'Send invitation' }).click();
    await expectToast(page, 'Invitation sent to wulan.sari@nusantaradigital.co.id');
    await expect(dialog(page)).toHaveCount(0);
    const invited = row(page, 'wulan.sari@nusantaradigital.co.id');
    await expect(invited).toContainText('Invited');
    await expect(invited).toContainText('Storage Admin');
    await invited.click();
    await expect(drawer(page)).toContainText('The invitation is waiting for this person to accept it.');
    await expect(drawer(page)).toContainText('Roles can be granted after the person accepts the invitation.');
    await expect(drawer(page).locator('button', { hasText: 'Grant role' })).toBeDisabled();
    // The status of an invited membership changes only when the person accepts, so Disable says why it is not offered.
    await expect(drawer(page)).toContainText('An invited membership becomes active when the person accepts the invitation. It can be disabled after that.');
    await expect(drawer(page).locator('button', { hasText: /^Disable$/ })).toBeDisabled();
  });

  test('Edit makes a person a Storage Admin; a grant to that person then waits for the other Tenant Admin', async ({ page }) => {
    await openScreen(page, meta);
    await openPerson(page, 'Bagus Prasetyo');
    await expectOverlayReadable(page);
    await drawer(page).locator('button', { hasText: /^Edit$/ }).click();
    await expect(dialog(page)).toContainText('Edit Bagus Prasetyo');
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dialog(page)).toContainText('Nothing was changed.');
    await dialog(page).getByLabel('Storage Admin').check();
    await expect(dialog(page)).toContainText('Role grants to an administrator wait for the approval of another Tenant Admin.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Save$/ }).click();
    await expectToast(page, 'Changes saved');
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Storage Admin');

    await drawer(page).locator('button', { hasText: 'Grant role' }).click();
    await expect(dialog(page)).toContainText('Grant a role to Bagus Prasetyo');
    await expect(dialog(page)).toContainText('Bagus Prasetyo is an administrator, so another Tenant Admin must approve this grant before it applies.');
    await expect(dialog(page)).toContainText('Who can approve: Tono Hartono');
    await dialog(page).locator('button', { hasText: 'Grant role' }).click();
    await expect(dialog(page)).toContainText('Required');
    await field(page, 'ms').selectOption({ label: 'ISMS, Information security management system' });
    await field(page, 'role').selectOption({ label: 'External Auditor' });
    await dialog(page).locator('button', { hasText: 'Grant role' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Required');
    await field(page, 'role').selectOption({ label: 'Risk Owner' });
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Grant role' }).click();
    await expectToast(page, 'Role grant waiting for approval');
    await expect(drawer(page)).toContainText('Risk Owner in ISMS');
    await expect(drawer(page).locator('[data-grants]')).toContainText('waiting for approval');
    await expect(page.locator('main')).toContainText('3 role grants are waiting');
  });

  test('Revoke role shows the open items of that system with its primary manager and a link to Handover', async ({ page }) => {
    await openScreen(page, meta);
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('Revoke Domain Owner in ISMS');
    await expect(dialog(page)).toContainText('Open items held in ISMS');
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText(/\d+ open items/);
    await expect(dialog(page).locator('[data-holdings="isms"]')).toContainText('Evidence:');
    await expect(dialog(page)).toContainText('Primary Management System Manager: Rina Kusuma (rina.kusuma@nusantaradigital.co.id)');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Open Handover' }).click();
    await expect(page.locator('main h1')).toHaveText('Handover');
    await expect(page.locator('main select').first()).toHaveValue('bagus');
    await expect(page.locator('main')).toContainText('Open items of Bagus Prasetyo in ISMS');

    await openScreen(page, meta);
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('[data-grant]', { hasText: 'Domain Owner in QMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('Bagus Prasetyo holds no open items in QMS.');
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    await expectToast(page, 'Role revoked');
    await expect(drawer(page)).not.toContainText('Domain Owner in QMS');
  });

  test('Revoke role on a waiting grant reads its current state and withdraws the request', async ({ page }) => {
    await openScreen(page, meta);
    await openPerson(page, 'Yusuf Rahman');
    await drawer(page).locator('[data-grant]', { hasText: 'Risk Owner in ISMS' }).locator('button', { hasText: 'Revoke role' }).click();
    await expect(dialog(page)).toContainText('Revoke Risk Owner in ISMS');
    await expect(dialog(page)).toContainText('The request is withdrawn and never applies.');
    await expect(dialog(page)).not.toContainText('Checking the current state');
    await expect(dialog(page)).not.toContainText('Open items held in ISMS');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Revoke role' }).click();
    await expectToast(page, 'Role revoked');
    await expect(drawer(page)).not.toContainText('Risk Owner in ISMS');
    await expect(page.locator('main')).toContainText('1 role grant is waiting');
  });

  test('Disable shows the open items per system and needs the email typed; Enable again', async ({ page }) => {
    await openScreen(page, meta);
    await openPerson(page, 'Rina Kusuma');
    await expect(drawer(page)).toContainText('You cannot disable your own membership.');
    await page.keyboard.press('Escape');
    await openPerson(page, 'Bagus Prasetyo');
    await drawer(page).locator('button', { hasText: /^Disable$/ }).click();
    await expect(dialog(page)).toContainText('Disable Bagus Prasetyo');
    await expect(dialog(page).locator('[data-holdings]')).toHaveCount(2);
    await expect(dialog(page).locator('[data-holdings="bcms"]')).toContainText('Primary Management System Manager: Tono Hartono');
    await expectOverlayReadable(page);
    const confirm = dialog(page).locator('button', { hasText: /^Disable$/ });
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel('Type bagus.prasetyo@nusantaradigital.co.id to confirm').fill('bagus.prasetyo@nusantaradigital.co.id');
    await confirm.click();
    await expectToast(page, 'Bagus Prasetyo is disabled');
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Disabled');
    await drawer(page).locator('button', { hasText: 'Enable again' }).click();
    await expect(dialog(page)).toContainText('An active member counts towards the user limit.');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: /^Enable$/ }).click();
    await expectToast(page, 'Bagus Prasetyo is active again');
    await expect(row(page, 'Bagus Prasetyo')).toContainText('Active');
  });

  test('Pre-register company sign-in and Reset sign-in factor', async ({ page }) => {
    await openScreen(page, meta);
    await openPerson(page, 'Dewi Anggraini');
    await drawer(page).locator('button', { hasText: 'Pre-register company sign-in' }).click();
    await expect(dialog(page)).toContainText('Pre-register company sign-in for Dewi Anggraini');
    await expect(field(page, 'provider')).toHaveValue('entra');
    await field(page, 'subject').fill('6b1d3c2e-0f4a-4e7b-9a1c-2d3e4f5a6b7c');
    await expectOverlayReadable(page);
    await dialog(page).locator('button', { hasText: 'Register' }).click();
    await expectToast(page, 'Company sign-in registered');
    await drawer(page).locator('button', { hasText: 'Reset sign-in factor' }).click();
    await expect(dialog(page)).toContainText('The authenticator and recovery codes of Dewi Anggraini are removed');
    await dialog(page).locator('button', { hasText: 'Reset factor' }).click();
    await expectToast(page, 'Sign-in factor reset');
    await expect(row(page, 'Dewi Anggraini')).toContainText('Not set up');

    await page.keyboard.press('Escape');
    await openPerson(page, 'Hendra Wijaya');
    await drawer(page).locator('button', { hasText: 'Reset sign-in factor' }).click();
    await expect(dialog(page)).toContainText('only the MSCD platform operator can reset the factor');
    await dialog(page).locator('button', { hasText: 'Reset factor' }).click();
    await expect(dialog(page).locator('[role="alert"]')).toContainText('Forbidden');
  });

  test('Export roles and responsibilities downloads a CSV built in the browser', async ({ page }) => {
    await openScreen(page, meta);
    const [download] = await Promise.all([page.waitForEvent('download'), ui.pageAction(page, 'Export roles and responsibilities').click()]);
    expect(download.suggestedFilename()).toMatch(/^roles-and-responsibilities-ndt-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (await readFile(await download.path(), 'utf8')).replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Person,Email,Role,System,Primary,Granted by,Since,Valid until');
    expect(lines).toContain('Sari Wulandari,sari.wulandari@nusantaradigital.co.id,Management System Manager,QMS,Yes,Rina Kusuma,2026-02-02,');
    expect(lines).toContain('Rina Kusuma,rina.kusuma@nusantaradigital.co.id,Tenant Admin,Whole organisation,,,,');
    expect(lines.some((l) => l.startsWith('Yusuf Rahman') && l.includes('Risk Owner'))).toBe(false);
    await expectToast(page, 'Roles and responsibilities exported (CSV)');
  });

  for (const theme of ['light', 'dark']) {
    test(`the forms are readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      await expect(row(page, 'Sari Wulandari')).toContainText('Management System Manager di QMS, utama');
      await ui.pageAction(page, 'Undang orang').click();
      await expect(dialog(page)).toContainText('Undang seseorang');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await openPerson(page, 'Yusuf Rahman');
      await expectOverlayReadable(page);
      await drawer(page).locator('button', { hasText: 'Berikan peran' }).click();
      await expect(dialog(page)).toContainText('Yang dapat menyetujui: Tono Hartono');
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await drawer(page).locator('button', { hasText: /^Nonaktifkan$/ }).click();
      await expect(dialog(page)).toContainText('Item terbuka yang dipegang, per sistem manajemen');
      await expectOverlayReadable(page);
    });
  }
});
