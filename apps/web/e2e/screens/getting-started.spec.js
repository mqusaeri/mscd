import { test, expect, ui, openScreen, metaById, expectReadableText, expectNoHorizontalOverflow, expectNoTextOverflow, pageSettled } from '../helpers.js';

// Getting started of the sample build (MILESTONE-2 M2-16): the onboarding checklist of the sample organisation, first
// in the Administration group. @sample-only: the API project covers the screen in e2e/api-only/getting-started.spec.js.
const meta = metaById('getting-started');
const step = (page, key) => page.locator(`main li[data-step="${key}"]`);

test.describe('Getting started @sample-only', () => {
  test('is first in Administration and shows the progress, the steps and the warnings', async ({ page }) => {
    await openScreen(page, meta);
    const main = page.locator('main');
    await expect(main.locator('h1')).toHaveText('Getting started');
    const admin = page.locator('aside nav button');
    const labels = await admin.evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    expect(labels.indexOf('Getting started')).toBeLessThan(labels.indexOf('Framework library'));
    await expect(main.locator('.mx-gs-progress')).toHaveText(/^\d+ of \d+ steps done$/);
    await expect(main.locator('svg[data-scene="getting-started"]')).toBeVisible();
    await expect(main).toContainText('Organisation');
    for (const system of ['ISMS, ISO/IEC 27001', 'QMS, ISO 9001', 'BCMS, ISO 22301', 'ABMS, ISO 37001']) await expect(main).toContainText(system);
    // ABMS has one person who can verify: separation of duties keeps its work from Implemented.
    await expect(main).toContainText('Fewer than two people can verify in this system');
    await expect(main.locator('li[data-step="internal_auditor"] .mx-badge', { hasText: 'Optional' }).first()).toBeVisible();
    await expect(main).toContainText('86 of 150 seats in use');
    await expectNoHorizontalOverflow(page);
    await expectNoTextOverflow(page);
    await expectReadableText(page, 4.5);
  });

  test('a step of another system manager opens a prepared email to that manager', async ({ page }) => {
    await openScreen(page, meta);
    // QMS has no Stage 1 and Stage 2 events in the sample; its manager is Sari Wulandari.
    const mail = page.locator('main a[href^="mailto:sari.wulandari@nusantaradigital.co.id?"]');
    await expect(mail).toHaveText('Email Sari Wulandari');
    const href = await mail.getAttribute('href');
    const url = new URL(href.replace('mailto:', 'mailto://'));
    expect(url.searchParams.get('subject')).toBe('MSCD: Plan the Stage 1 and Stage 2 audits for QMS, ISO 9001');
    expect(url.searchParams.get('body')).toContain('Hello Sari Wulandari,');
    await expect(page.locator('main')).toContainText('For the Management System Manager');
    await expect(page.locator('main')).toContainText('Assigned to Sari Wulandari');
  });

  test('a step button opens the screen that completes it, and Check again reads the list again', async ({ page }) => {
    await openScreen(page, meta);
    await page.locator('main button', { hasText: 'Check again' }).click();
    await expect(page.locator('main .mx-gs-progress')).toBeVisible();
    await page.locator('main li[data-step="licence"] button', { hasText: 'Open Licence' }).click();
    await expect(ui.title(page)).toHaveText('Licence');
    await expect(page.locator('main [data-screen="license"]')).toBeVisible();
  });

  for (const theme of ['light', 'dark']) {
    test(`is readable in Indonesian, ${theme} theme`, async ({ page }) => {
      await openScreen(page, meta, `lang=id&theme=${theme}`);
      const main = page.locator('main');
      await expect(main.locator('h1')).toHaveText('Mulai di sini');
      await expect(main.locator('.mx-gs-progress')).toHaveText(/^\d+ dari \d+ langkah selesai$/);
      await expect(main).toContainText('Untuk Management System Manager');
      await expect(main.locator('a[href^="mailto:"]').first()).toContainText('Kirim email ke');
      await pageSettled(page);
      await expectReadableText(page, 4.5);
    });
  }

  test('Domain Owners and auditors do not see it', async ({ page }) => {
    await page.goto('/?screen=getting-started&persona=owner');
    await expect(ui.title(page)).toHaveText('My Tasks');
    await expect(ui.nav(page, 'Getting started')).toHaveCount(0);
    await expect(step(page, 'licence')).toHaveCount(0);
  });
});
