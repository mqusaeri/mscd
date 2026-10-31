import { test, expect, ui, expectReadableText, pageSettled } from '../helpers.js';
import { DEMO_PASSWORD, EMAILS, demoCode, freshTotpStep } from '../../e2e-api/fixtures.js';

// Organisation discovery at sign-in (MILESTONE-2 M2-S11, D-S3): one sign-in page for every organisation. The work email
// and the password show together from the start; the domain of the email is looked up as the person types and adds the
// sign-in buttons of the organisation that verified it; the password hides only for an organisation that signs in with
// single sign-on only; `?org=` preselects an organisation and the last one signed in to is remembered; the footer links
// to the privacy notice and the terms of `system.profile.legal`.
//
// The stack of the API project runs one organisation per installation (tenancy.mode single) without identity providers,
// so the multi-tenant answers of `GET /auth/providers` (a verified domain with SSO, an organisation that allows SSO only)
// are served by `page.route` for the domains and slugs below; every other lookup reaches the api. The server side of
// discovery (verified domains only, the same answer for strangers, the limit of 20 a minute) is covered by
// apps/server/test/int/domains.
test.use({ apiSession: null });

const CORP = { local: true, providers: [{ slug: 'corp-entra', kind: 'oidc', label: 'Sign in with Corp Microsoft', icon: 'microsoft' }] };
const SSO_ONLY = { local: false, providers: [{ slug: 'only-kc', kind: 'oidc', label: 'Sign in with Only Keycloak', icon: 'generic' }] };
const ANSWERS_BY_DOMAIN = { 'sso-corp.example': CORP, 'sso-only.example': SSO_ONLY };
const ANSWERS_BY_ORG = { corp: CORP, onlysso: SSO_ONLY };

/** Serves the multi-tenant answers above and counts the lookups by email domain and by organisation. */
async function fakeDiscovery(page) {
  const seen = { domains: [], orgs: [], plain: 0 };
  await page.route((url) => url.pathname === '/api/v1/auth/providers', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const email = query.get('email');
    const org = query.get('org');
    if (email) {
      const domain = email.slice(email.lastIndexOf('@') + 1);
      seen.domains.push(domain);
      if (ANSWERS_BY_DOMAIN[domain]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANSWERS_BY_DOMAIN[domain]) });
    } else if (org) {
      seen.orgs.push(org);
      if (ANSWERS_BY_ORG[org]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANSWERS_BY_ORG[org]) });
    } else {
      seen.plain += 1;
    }
    return route.continue();
  });
  return seen;
}

/** The system profile of the api with changes (the legal links, the demo flag). */
async function profileWith(page, change) {
  await page.route((url) => url.pathname === '/api/v1/system/profile', async (route) => {
    const response = await route.fetch();
    const profile = await response.json();
    await route.fulfill({ response, body: JSON.stringify(change(profile)) });
  });
}

const email = (page) => page.locator('#au-email');
const password = (page) => page.locator('#au-password');
const ssoButton = (page, label) => page.locator('a.au-sso-btn', { hasText: label });
const lastOrg = (page) => page.evaluate(() => window.localStorage.getItem('mscd.auth.lastOrg'));

test.describe('Organisation discovery at sign-in @api-only', () => {
  test('email and password show together, the email domain adds the buttons of its organisation, and the password hides only for single sign-on only', async ({ page }) => {
    const seen = await fakeDiscovery(page);
    // The page's timers run on Playwright's clock (time flows as usual), so the last step can run them on at once.
    await page.clock.install();
    await page.goto('/login');
    await expect(email(page)).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(page.locator('a.au-sso-btn')).toHaveCount(0);

    // Typed one key at a time: the lookup waits for a pause, so only the whole domain is asked for.
    await email(page).pressSequentially('andi@sso-corp.example', { delay: 25 });
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toBeVisible();
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toHaveAttribute('href', /^\/api\/v1\/auth\/oidc\/corp-entra\/start(\?|$)/);
    await expect(page.getByText('or with email')).toBeVisible();
    await expect(password(page)).toBeVisible();
    expect(seen.domains).toEqual(['sso-corp.example']);

    // An organisation that allows single sign-on only: the password and Continue go, the email stays.
    await email(page).fill('budi@sso-only.example');
    await expect(ssoButton(page, 'Sign in with Only Keycloak')).toBeVisible();
    await expect(password(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await expect(page.getByText('Your organisation signs in with single sign-on only.')).toBeVisible();
    await expect(email(page)).toBeVisible();

    // A domain no organisation verified (answered by the api): no buttons, the password is back.
    await email(page).fill('citra@unknown-company.example');
    await expect.poll(() => seen.domains.includes('unknown-company.example')).toBe(true);
    await expect(page.locator('a.au-sso-btn')).toHaveCount(0);
    await expect(password(page)).toBeVisible();

    // Back to a domain already looked up: answered from the page, no new request. A lookup would start 450 ms after the
    // change (lookupDelay of LoginPage.tsx): the clock runs the page's timers 500 ms on, then no request is under way.
    await email(page).fill('andi@sso-corp.example');
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toBeVisible();
    await page.clock.runFor(500);
    await pageSettled(page);
    expect(seen.domains.filter((d) => d === 'sso-corp.example')).toHaveLength(1);
    expect(seen.orgs).toEqual([]);
  });

  test('?org= preselects an organisation at once, without remembering it, and a person of another organisation still reaches the password', async ({ page }) => {
    const seen = await fakeDiscovery(page);
    const other = page.getByRole('button', { name: 'Use a different organisation' });
    await page.goto('/login?org=onlysso');
    await expect(ssoButton(page, 'Sign in with Only Keycloak')).toBeVisible();
    await expect(password(page)).toHaveCount(0);
    expect(seen.orgs).toEqual(['onlysso']);
    // The organisation named in the address hides the password, so the page offers another organisation; nothing is stored.
    await expect(other).toBeVisible();
    expect(await lastOrg(page)).toBeNull();

    // An email of another organisation with sign-in buttons takes over.
    await email(page).fill('andi@sso-corp.example');
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(other).toHaveCount(0);

    // An email whose domain names no organisation keeps the answer of the address (D-S10); "Use a different
    // organisation" drops it, and the password is back.
    await email(page).fill('citra@unknown-company.example');
    await expect.poll(() => seen.domains.includes('unknown-company.example')).toBe(true);
    await expect(password(page)).toHaveCount(0);
    const plainBefore = seen.plain;
    await other.click();
    await expect(password(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.locator('a.au-sso-btn')).toHaveCount(0);
    await expect(other).toHaveCount(0);
    await expect(email(page)).toHaveValue('citra@unknown-company.example');
    await expect.poll(() => seen.plain).toBeGreaterThan(plainBefore);
    expect(await lastOrg(page)).toBeNull();

    // An organisation in the address whose answer shows the password: nothing to offer.
    await page.goto('/login?org=corp');
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(other).toHaveCount(0);
    expect(await lastOrg(page)).toBeNull();
  });

  test('a sign-in with email and password in one pass remembers the organisation, which the next sign-in page preselects', async ({ page }) => {
    const seen = await fakeDiscovery(page);
    await freshTotpStep();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await email(page).fill(EMAILS.rina);
    await password(page).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await page.getByLabel('Authentication code').fill(demoCode('rina'));
    await expect(ui.title(page)).toBeVisible();
    expect(await lastOrg(page)).toBe('ndt');

    await ui.roleButton(page).click();
    await page.locator('header div[style*="width: 300px"] button', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('You have signed out.')).toBeVisible();
    await expect.poll(() => seen.orgs).toContain('ndt');
    const forget = page.getByRole('button', { name: 'Use a different organisation' });
    await expect(forget).toBeVisible();

    // Forgetting it asks for the sign-in of the installation again and clears the memory.
    const plainBefore = seen.plain;
    await forget.click();
    await expect(forget).toHaveCount(0);
    expect(await lastOrg(page)).toBeNull();
    await expect.poll(() => seen.plain).toBeGreaterThan(plainBefore);
  });

  test('a page whose storage is blocked still signs in with email and password and opens the app', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    await freshTotpStep();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Use a different organisation' })).toHaveCount(0);
    await email(page).fill(EMAILS.hendra);
    await password(page).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await page.getByLabel('Authentication code').fill(demoCode('hendra'));
    // Opening the app tries to remember the organisation; with no storage it is not kept, and the app still opens.
    await expect(ui.title(page)).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);

    await ui.roleButton(page).click();
    await page.locator('header div[style*="width: 300px"] button', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('You have signed out.')).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use a different organisation' })).toHaveCount(0);
  });

  test('the footer links to the privacy notice and the terms of the system profile, each hidden when not set; the placeholder is a generic address', async ({ page }) => {
    // The test profile is a demo installation without legal links: the demo address, no links.
    await page.goto('/login');
    await expect(email(page)).toHaveAttribute('placeholder', 'rina.kusuma@nusantaradigital.co.id');
    await expect(page.locator('nav.au-legal')).toHaveCount(0);

    await profileWith(page, (profile) => ({
      ...profile,
      demo: { enabled: false, personas: false },
      legal: { privacyUrl: 'https://mscd.example.id/privacy', termsUrl: 'https://mscd.example.id/terms' },
    }));
    await page.goto('/login');
    await expect(email(page)).toHaveAttribute('placeholder', 'name@company.com');
    const legal = page.getByRole('navigation', { name: 'Privacy and terms' });
    await expect(legal.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', 'https://mscd.example.id/privacy');
    await expect(legal.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', 'https://mscd.example.id/terms');
    await expectReadableText(page, 4.5);

    await page.goto('/login?lang=id&theme=dark');
    await expect(email(page)).toHaveAttribute('placeholder', 'nama@perusahaan.co.id');
    const legalId = page.getByRole('navigation', { name: 'Privasi dan ketentuan' });
    await expect(legalId.getByRole('link', { name: 'Pemberitahuan privasi' })).toBeVisible();
    await expect(legalId.getByRole('link', { name: 'Ketentuan layanan' })).toBeVisible();
    await expectReadableText(page, 4.5);
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('main *')) {
        if (el.closest('svg') || !el.getClientRects().length) continue;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        if (own && parseFloat(getComputedStyle(el).fontSize) < 11.95) out.push(`${getComputedStyle(el).fontSize} "${own.slice(0, 40)}"`);
      }
      return out;
    });
    expect(small, 'sign-in text under 12px').toEqual([]);

    // Only the privacy notice set: the terms link is not shown.
    await page.unrouteAll({ behavior: 'wait' });
    await profileWith(page, (profile) => ({ ...profile, legal: { privacyUrl: 'https://mscd.example.id/privacy', termsUrl: null } }));
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Privacy notice' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of service' })).toHaveCount(0);
  });

  test('the remembered organisation and the email lookup work with a session that ended, also in Indonesian', async ({ page }) => {
    await fakeDiscovery(page);
    await page.addInitScript(() => window.localStorage.setItem('mscd.auth.lastOrg', 'corp'));
    await page.goto('/login?lang=id');
    await expect(ssoButton(page, 'Sign in with Corp Microsoft')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gunakan organisasi lain' })).toBeVisible();
    await expect(password(page)).toBeVisible();
    await email(page).fill('budi@sso-only.example');
    await expect(page.getByText('Organisasi Anda hanya menggunakan single sign-on untuk masuk.')).toBeVisible();
    await expect(password(page)).toHaveCount(0);
  });
});
