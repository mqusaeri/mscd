// SaaS end-to-end run (Milestone 2 plan K.6, M2-S13): two customer organisations on one SaaS stack of release images,
// every step in the browser. run-saas.mjs starts the stack, runs saas-ops.sh create-operator and passes the state of
// the run (SAAS_RUN_STATE). The run fails on any page error, console error, 5xx answer or 4xx answer that its step
// does not expect, checks the readability of every operator screen it visits (WCAG AA contrast, no text under 12px),
// and checks the cookies of every person.
//
//   1. The platform operator, made by saas-ops.sh create-operator, sets a password from the emailed link and enrols TOTP.
//   2. The operator creates Alpha (plan preset standard) and Beta (trial) and verifies Alpha's email domain through the
//      mock DNS.
//   3. Each first administrator accepts the emailed invitation; Alpha's administrator signs in again by work email
//      discovery, on the sign-in page with the privacy notice and terms links.
//   4. Each administrator invites a second administrator, creates a management system, asks for the Management System
//      Manager role (the second administrator approves it, four eyes) and uploads a file into the Managed Vault.
//   5. Isolation: Beta's administrator opens Alpha's system, file and export URLs and gets 404; discovery answers an
//      unknown slug as it answers a known one.
//   6. Suspending Beta ends its sessions, sign-in shows the inactive message, Alpha keeps working; Beta is reactivated.
//   7. Offboarding Beta: reads work, writes answer 403.
//   8. The operator lowers Alpha's user limit to its current use: the next invitation shows the LIC-USERS message.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { ORGS, PASSWORD } from '../lib/saas-data.mjs';
import { linkFor, waitForMail } from '../lib/mailpit.mjs';
import { PANEL_SCOPE, expectOverlayReadable, expectReadableText } from '../lib/readable.mjs';
import { codeOf, secondsLeftInStep } from '../lib/totp.mjs';

if (!process.env.SAAS_RUN_STATE) throw new Error('SAAS_RUN_STATE is not set: run it with npm run saas -w @mscd/smoke (run-saas.mjs starts the stack first)');
const state = JSON.parse(readFileSync(process.env.SAAS_RUN_STATE, 'utf8'));
const { alpha: ALPHA, beta: BETA } = ORGS;

/** The cookies MSCD may set (docs/saas/legal-inputs.md, "Cookies and browser storage"; GL-56). */
const ESSENTIAL_COOKIES = new Set(['__Host-mscd_session', 'mscd_auth_tx', 'mscd_saml_tx', 'mscd_guest_tx', 'mscd_repo_tx']);
/** The full-page message after a sign-in to a suspended organisation: the app's load failure with the server's reason. */
const INACTIVE = ['MSCD could not load its data.', 'The organisation is not active'];

// ---- locators of the app (the structure the web E2E suites use, apps/web/e2e/helpers.js) ----
const ui = {
  title: (page) => page.locator('main h1'),
  toast: (page) => page.locator('div[style*="z-index: 60"]'),
  drawer: (page) => page.locator('div[style*="z-index: 41"]'),
  modal: (page) => page.locator('div[style*="z-index: 51"]'),
  nav: (page, label) => page.locator(`aside nav button[title="${label}"]`),
  msSwitch: (page) => page.locator('header button[title="Switch management system"]'),
  pageAction: (page, label) => page.locator(`main button[title="${label}"]`).first(),
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^\\s*${esc(name)}\\s*$`) });

// ---- people and their browser sessions ----
/** What the run remembers between its steps: the authenticator secret each person enrolled (their phone). */
const secrets = new Map();
const lastStep = new Map();
const visited = new Set();
const sessions = new Map();
const problems = [];
/** The person whose organisation is suspended while the suspension step signs them in. */
let inactiveFor = null;
/** Files the administrators uploaded and the export Alpha started: the targets of the isolation step. */
const found = {};

/**
 * Answers from 400 to 499 that belong to the run: `status`, `method`, `path` (matched against the path and query) and
 * `who` (a person key or a list of them; absent for anyone). Any other 4xx answer, and every 5xx answer, fails the run.
 */
const EXPECTED_ALWAYS = [
  // The app asks for the session first; without one the answer is 401 and the sign-in page opens (build plan H.7).
  { status: 401, method: 'GET', path: /^\/api\/v1\/me$/ },
];
/** The answers the current step expects (`expecting`), and from the suspension on the end of Beta's sessions. */
const expectedNow = [];
/** Every answer of 400 or more a page received (`who status url`), expected or not, for the browser's console lines. */
const answered = new Set();
/** The browser's "Failed to load resource" lines, checked after each step against the answers the pages received. */
const failedLoads = [];

function isExpected(who, status, method, url) {
  const path = url.pathname + url.search;
  return [...EXPECTED_ALWAYS, ...expectedNow].some((a) => a.status === status && a.method === method && a.path.test(path) && (!a.who || [a.who].flat().includes(who)));
}

/** Runs `fn` while the answers it names are expected; they count as problems again when it ends. */
async function expecting(answers, fn) {
  expectedNow.push(...answers);
  try {
    return await fn();
  } finally {
    for (const a of answers) expectedNow.splice(expectedNow.indexOf(a), 1);
  }
}

/** A console line of a failed load counts as a problem unless its page received that answer (checked after each step). */
function checkFailedLoads() {
  for (const line of failedLoads.splice(0)) {
    if (!answered.has(`${line.who} ${line.status} ${line.url}`)) problems.push(`${line.who}: console.error: ${line.text} (${line.url || 'no address'})`);
  }
}

/** Records page errors, console errors, 5xx answers and unexpected 4xx answers of a person's page (the run fails on any of them). */
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who}: pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The browser logs every 4xx and 5xx answer as "Failed to load resource" with the address of the request. The
    // response listener below judges that answer (expected or not); the line itself is checked after the step.
    const failed = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(text);
    if (failed) {
      failedLoads.push({ who, status: Number(failed[1]), url: m.location().url, text });
      return;
    }
    // An API answer opened as a page (the isolation step) carries Content-Security-Policy "sandbox", so the browser
    // blocks its own viewer script there: the security header at work, not an error of the app.
    if (/^Blocked script execution in 'https:\/\/[^/]+\/api\/v1\/[^']*' because the document's frame is sandboxed/.test(text)) return;
    // The app logs the refusal of its first load; for a member of a suspended organisation that refusal is the
    // expected 403 organisation-inactive (the suspension step), shown on the page as the inactive message.
    if (inactiveFor === who && /^data load failed ApiLoadError: The organisation is not active/.test(text)) return;
    problems.push(`${who}: console.error: ${text}`);
  });
  page.on('response', (r) => {
    const status = r.status();
    if (status < 400) return;
    answered.add(`${who} ${status} ${r.url()}`);
    const method = r.request().method();
    const url = new URL(r.url());
    if (status < 500 && isExpected(who, status, method, url)) return;
    problems.push(`${who}: ${status} ${method} ${url.pathname}${url.search}`);
  });
}

function personOf(key) {
  if (key === 'operator') return state.operator;
  // Someone who is not signed in, on a computer that has never opened MSCD.
  if (key === 'stranger') return { key, name: 'A stranger' };
  for (const org of Object.values(ORGS)) for (const p of [org.admin, org.second, org.extra]) if (p?.key === key) return { ...p, org };
  throw new Error(`unknown person ${key}`);
}

/** The browser session of a person (one context each); `fresh` starts a new browser, as on another computer. */
async function person(browser, key, { fresh = false } = {}) {
  if (sessions.has(key) && !fresh) return sessions.get(key);
  if (sessions.has(key)) await sessions.get(key).context.close();
  const context = await browser.newContext();
  const page = await context.newPage();
  watch(page, key);
  const s = { key, who: personOf(key), context, page };
  sessions.set(key, s);
  return s;
}

/** Checks the readability of a screen the person sees for the first time. */
async function firstVisit(s, screen, scope) {
  const key = `${s.key}:${screen}`;
  if (visited.has(key)) return;
  await expectReadableText(s.page, `${screen} (${s.key})`, scope);
  visited.add(key);
}

/** Waits for a fresh TOTP step when the current one ends within a few seconds. */
async function freshStep(page, margin = 5) {
  const left = secondsLeftInStep();
  if (left < margin) await page.waitForTimeout(left * 1000 + 400);
}

/** The authenticator enrolment after a first sign-in: the secret is read from the page, as a phone scans it. */
async function enrol(s) {
  const { page } = s;
  await expect(page).toHaveURL(/\/login\/enrol/);
  const secret = (await page.getByTestId('enrol-secret').innerText()).replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  secrets.set(s.key, secret);
  await firstVisit(s, 'the enrolment page');
  await freshStep(page);
  lastStep.set(s.key, Math.floor(Date.now() / 30_000));
  await page.locator('#au-confirm').fill(codeOf(secret));
  await expect(page.locator('ul.au-codes li')).toHaveCount(10);
  await page.locator('label.au-check input').check();
  await page.getByRole('button', { name: 'Continue to MSCD' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The current code of a person's authenticator, never the step it used last (the server refuses a reused step). */
async function totpCode(s) {
  const { page } = s;
  await freshStep(page);
  const step = Math.floor(Date.now() / 30_000);
  if (lastStep.get(s.key) === step) await page.waitForTimeout((step + 1) * 30_000 - Date.now() + 400);
  lastStep.set(s.key, Math.floor(Date.now() / 30_000));
  return codeOf(secrets.get(s.key));
}

/** Email and password on the sign-in page (already open), then the second factor. */
async function passwordAndCode(s) {
  const { page } = s;
  await page.locator('#au-email').fill(s.who.email);
  await page.locator('#au-password').fill(PASSWORD);
  await page.locator('.au-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await expect(page.locator('#au-code')).toBeVisible();
  await firstVisit(s, 'the second-factor page');
  await page.locator('#au-code').fill(await totpCode(s));
}

/** Signs a person in with password and authenticator code, and waits for the app. */
async function signIn(s) {
  const { page } = s;
  await page.goto('/');
  await expect(page.locator('main h1, #au-email').first()).toBeVisible();
  if (!/\/login/.test(page.url())) return;
  await firstVisit(s, 'the sign-in page');
  await passwordAndCode(s);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await expect(ui.title(page).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Accepts an emailed invitation with a new password and enrols the authenticator. */
async function acceptInvitation(s) {
  const { page } = s;
  await page.goto(await linkFor(s.who.email));
  await expect(page.locator('#au-new-password')).toBeVisible();
  await firstVisit(s, 'the invitation page');
  await page.locator('#au-new-password').fill(PASSWORD);
  await page.locator('#au-repeat-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password and continue' }).click();
  await enrol(s);
}

/** Loads the app again, as a person does after another person changed their roles or organisation. */
async function reloadApp(s) {
  await s.page.waitForLoadState('networkidle');
  await s.page.goto('/');
  await expect(ui.title(s.page).first()).toBeVisible();
  await s.page.waitForLoadState('networkidle');
}

/** Waits until the screen has loaded (no loading line, no busy indicator). */
async function settle(page) {
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('main [role="status"]', { hasText: /^Loading/ })).toHaveCount(0);
}

async function closeLayers(page) {
  for (let i = 0; i < 3 && (await page.locator('div[style*="z-index: 51"], div[style*="z-index: 41"]').count()); i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

async function switchMs(page, short) {
  const current = await ui.msSwitch(page).innerText().catch(() => '');
  if (current.includes(short)) return;
  await ui.msSwitch(page).click();
  await page.locator('header div[style*="width: 420px"] button').filter({ has: page.locator('span', { hasText: new RegExp(`^${short}$`) }) }).click();
  await expect(ui.msSwitch(page)).toContainText(short);
}

/** Opens a screen from the sidebar and checks the readability of every screen a person visits for the first time. */
async function go(s, label, { ms } = {}) {
  const { page } = s;
  await closeLayers(page);
  if (ms) await switchMs(page, ms);
  await ui.nav(page, label).click();
  await expect(ui.title(page)).toHaveText(label);
  await settle(page);
  await firstVisit(s, label);
}

async function expectToast(page, text) {
  await expect(ui.toast(page)).toContainText(text);
}

/** Every cookie of a person's browser is one of the essential cookies, HttpOnly and Secure (GL-56). */
async function expectEssentialCookies(s) {
  const cookies = await s.context.cookies();
  for (const c of cookies) {
    expect(ESSENTIAL_COOKIES.has(c.name), `cookie ${c.name} of ${s.key} is not in the cookie list of legal-inputs.md`).toBe(true);
    expect(c.httpOnly, `cookie ${c.name} is HttpOnly`).toBe(true);
    expect(c.secure, `cookie ${c.name} is Secure`).toBe(true);
  }
}

/** Runs a command in a service of the stack (`docker compose exec`); returns its output. */
function composeExec(service, args) {
  const r = spawnSync('docker', ['compose', '--project-name', state.project, ...state.files.flatMap((f) => ['-f', f]), '--env-file', state.envFile, 'exec', '-T', service, ...args], {
    encoding: 'utf8', timeout: 60_000,
  });
  expect(r.status, `docker compose exec ${service}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** Publishes a TXT record in the mock DNS, as the customer's IT team adds it to their domain. */
function publishTxt(name, value) {
  const script = `const r = await fetch('http://127.0.0.1:4310/_admin/dns/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ name, values: [value] })}) }); if (!r.ok) { process.stderr.write(String(r.status) + ' ' + await r.text()); process.exit(1); }`;
  composeExec('mock-providers', ['node', '--input-type=module', '-e', script]);
}

/** A small text file an administrator uploads as evidence, unique per organisation. */
function evidenceFile(org) {
  const text = `${org.name}: ${org.system.code} evidence of the SaaS end-to-end run, ${new Date().toISOString()}\n`;
  return { name: `${org.system.code}-evidence-${org.slug}.txt`, mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') };
}

// ---- the operator console ----
async function operatorOrganisations(op) {
  const { page } = op;
  await closeLayers(page);
  await page.locator('main [role="tab"]', { hasText: 'Organisations' }).click();
  await settle(page);
  await firstVisit(op, 'the organisations of the operator console');
}

const orgRow = (page, org) => page.locator('main table tbody tr', { hasText: org.slug }).filter({ hasText: org.name });

/** Opens the Manage drawer of an organisation on a tab of it. */
async function manage(op, org, tab) {
  const { page } = op;
  await operatorOrganisations(op);
  await button(orgRow(page, org), 'Manage').click();
  const drawer = ui.drawer(page);
  await expect(drawer).toContainText(org.name);
  await drawer.getByRole('tab', { name: tab, exact: true }).click();
  await settle(page);
  if (!visited.has(`operator:drawer:${tab}`)) {
    await expectOverlayReadable(page, `the ${tab} tab of the organisation drawer`);
    visited.add(`operator:drawer:${tab}`);
  }
  return drawer;
}

/** Moves an organisation to another status in the Status tab: reason, slug confirmation, the result. */
async function moveStatus(op, org, action, reason) {
  const { page } = op;
  const drawer = await manage(op, org, 'Status');
  await button(drawer, action).click();
  const dialog = ui.modal(page);
  await expect(dialog).toContainText(`${action}: ${org.name}`);
  await dialog.getByLabel(/^Reason/).fill(reason);
  const confirm = dialog.getByLabel(/^Type the slug/);
  if (await confirm.count()) await confirm.fill(org.slug);
  await expectOverlayReadable(page, `${action}: ${org.name}`);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/status') && r.request().method() === 'POST');
  await button(dialog, action).click();
  const result = await answer;
  expect(result.status(), await result.text()).toBe(200);
  const moved = await result.json();
  await expect(drawer).toContainText(`${org.name} is now`);
  await expectOverlayReadable(page, `the result of ${action}`);
  await closeLayers(page);
  return moved;
}

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  checkFailedLoads();
  expect(problems, 'page errors, console errors, 5xx answers and unexpected 4xx answers during the step').toEqual([]);
});

test.afterAll(async () => {
  for (const s of sessions.values()) await s.context.close().catch(() => {});
});

test.describe('SaaS: two organisations on one service', () => {
  test('the platform operator made by saas-ops.sh sets a password from the emailed link and enrols an authenticator', async ({ browser }) => {
    const op = await person(browser, 'operator');
    const { page } = op;
    await page.goto(await linkFor(state.operator.email, 'reset'));
    await expect(page.locator('#au-new-password')).toBeVisible();
    await firstVisit(op, 'the set-password page');
    await page.locator('#au-new-password').fill(PASSWORD);
    await page.locator('#au-repeat-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.locator('#au-email')).toBeVisible();
    await firstVisit(op, 'the sign-in page');
    await page.locator('#au-email').fill(state.operator.email);
    await page.locator('#au-password').fill(PASSWORD);
    await page.locator('.au-form button[type="submit"]').click();
    await enrol(op);
    await expect(ui.title(page)).toHaveText('Operator console');
    await settle(page);
    await firstVisit(op, 'Operator console');
    await expectEssentialCookies(op);
  });

  test('the operator creates Alpha on the standard plan and Beta on the trial plan', async ({ browser }) => {
    const op = await person(browser, 'operator');
    const { page } = op;
    for (const org of [ALPHA, BETA]) {
      await operatorOrganisations(op);
      await ui.pageAction(page, 'Create organisation').click();
      const dialog = ui.modal(page);
      await expect(dialog).toContainText('Create an organisation');
      await dialog.getByLabel(/^Slug/).fill(org.slug);
      await dialog.getByLabel(/^Name/).fill(org.name);
      await dialog.getByLabel(/^Time zone/).selectOption(org.timeZone);
      await dialog.getByLabel(/^Number of sites/).fill(String(org.sites));
      await dialog.getByLabel(/^First administrator email/).fill(org.admin.email);
      await dialog.getByLabel(/^First administrator name/).fill(org.admin.name);
      await dialog.getByLabel(/^Plan/).selectOption(org.preset);
      await expectOverlayReadable(page, `Create an organisation (${org.slug})`);
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ops/organizations' && r.request().method() === 'POST');
      await button(dialog, 'Create').click();
      const created = await (await answer).json();
      expect(created.data?.slug).toBe(org.slug);
      org.id = created.data.id;
      await expect(dialog).toContainText(`Organisation created. The slug ${org.slug} cannot be changed.`);
      await expect(dialog).toContainText(`The invitation was emailed to ${org.admin.email}.`);
      await button(dialog, 'Close').click();
      const row = orgRow(page, org);
      await expect(row).toContainText(org.preset);
      await expect(row).toContainText('Active');
    }
    await expect(orgRow(page, ALPHA)).toContainText('0 of 50');
    await expect(orgRow(page, BETA)).toContainText('0 of 10');
    await expectReadableText(page, 'the organisations with Alpha and Beta');
  });

  test('the operator verifies the email domain of Alpha through the mock DNS', async ({ browser }) => {
    const op = await person(browser, 'operator');
    const { page } = op;
    const drawer = await manage(op, ALPHA, 'Domains');
    await drawer.getByRole('button', { name: 'Add domain' }).click();
    const add = ui.modal(page);
    await add.locator('input').fill(ALPHA.domain);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add).toContainText(`The TXT record for ${ALPHA.domain}`);
    const text = await add.innerText();
    const value = text.match(/mscd-verify=[A-Za-z0-9_-]+/)?.[0];
    const name = text.match(new RegExp(`_[a-z0-9-]+\\.${esc(ALPHA.domain)}`))?.[0];
    expect(value, 'the TXT value shown once').toBeTruthy();
    expect(name, 'the TXT record name').toBeTruthy();
    await expectOverlayReadable(page, 'the TXT record');
    await add.getByRole('button', { name: 'Done' }).click();
    publishTxt(name, value);
    await drawer.locator(`[data-domain="${ALPHA.domain}"]`).getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText(`The record of ${ALPHA.domain} was found. The domain is verified.`);
    await expectOverlayReadable(page, 'the verified domain');
    await closeLayers(page);
    await expect(orgRow(page, ALPHA)).toContainText(ALPHA.domain);
    await expect(orgRow(page, BETA)).not.toContainText(ALPHA.domain);
  });

  test('each first administrator accepts the emailed invitation; Alpha\'s administrator signs in again by work email', async ({ browser }) => {
    for (const org of [ALPHA, BETA]) {
      const admin = await person(browser, org.admin.key);
      await acceptInvitation(admin);
      await expect(ui.title(admin.page)).toHaveText('Getting started');
      await settle(admin.page);
      await firstVisit(admin, 'Getting started');
      await expectEssentialCookies(admin);
    }

    // Another computer: the sign-in page finds the organisation by the work email (discovery), with the privacy
    // notice and terms of the service in its footer.
    const ayu = await person(browser, ALPHA.admin.key, { fresh: true });
    const { page } = ayu;
    await page.goto('/login');
    await expect(page.locator('#au-email')).toBeVisible();
    const legal = page.locator('nav.au-legal');
    await expect(legal.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', state.legal.privacyUrl);
    await expect(legal.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', state.legal.termsUrl);
    await firstVisit(ayu, 'the sign-in page with the legal links');
    const lookup = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/providers' && new URL(r.url()).searchParams.get('email') === ALPHA.admin.email);
    await page.locator('#au-email').fill(ALPHA.admin.email);
    // The organisation has no company sign-in, so the answer is the one every email gets without one (D-S10); the
    // password sign-in then opens Alpha.
    const discovered = await lookup;
    expect(discovered.status()).toBe(200);
    expect(await discovered.json()).toMatchObject({ local: true, providers: [] });
    await page.locator('#au-password').fill(PASSWORD);
    await page.locator('.au-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await firstVisit(ayu, 'the second-factor page');
    await page.locator('#au-code').fill(await totpCode(ayu));
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    await expect(ui.title(page)).toHaveText('Getting started');
    const me = await page.request.get('/api/v1/me');
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect((body.data ?? body).org?.slug).toBe(ALPHA.slug);
  });

  for (const org of [ALPHA, BETA]) {
    test(`${org.key}: the administrator invites a second administrator, creates ${org.system.code} and is made its manager with the second administrator's approval`, async ({ browser }) => {
      const admin = await person(browser, org.admin.key);
      if (admin.page.url() === 'about:blank') await signIn(admin);
      await go(admin, 'People and roles');
      await ui.pageAction(admin.page, 'Invite person').click();
      const dialog = ui.modal(admin.page);
      await expect(dialog).toContainText('Invite a person');
      await dialog.locator('[name="email"]').fill(org.second.email);
      await dialog.locator('[name="displayName"]').fill(org.second.name);
      await dialog.locator('[name="jobTitle"]').fill(org.second.jobTitle);
      await dialog.getByLabel('Tenant Admin').check();
      await button(dialog, 'Send invitation').click();
      await expectToast(admin.page, `Invitation sent to ${org.second.email}`);
      const second = await person(browser, org.second.key);
      await acceptInvitation(second);
      await expect(ui.title(second.page)).toHaveText('Getting started');

      await go(admin, 'Management systems');
      await ui.pageAction(admin.page, 'New management system').click();
      const drawer = ui.drawer(admin.page);
      const field = (name) => drawer.locator(`[name="${name}"]`);
      await field('code').fill(org.system.code);
      await expect(field('slug')).toHaveValue(org.system.slug);
      await field('name').fill(org.system.name);
      await drawer.locator('select').first().selectOption(org.system.edition);
      await expect(drawer).toContainText('Installed');
      await field('scopeStatement').fill(org.system.scope);
      await drawer.getByLabel(org.system.colour).check();
      await drawer.locator('select').last().selectOption({ label: 'Managed Vault' });
      await expectOverlayReadable(admin.page, `New management system (${org.slug})`);
      await button(drawer, 'Save').click();
      await expectToast(admin.page, new RegExp(`${org.system.code} created`));
      const row = admin.page.locator('main table tbody tr', { hasText: org.system.framework });
      await expect(row).toContainText('Managed Vault');
      await expect(row).toContainText('Not assigned');

      // A grant to an administrator, here to herself, waits for a second Tenant Admin (D2-12).
      await go(admin, 'People and roles');
      await admin.page.locator('main table tbody tr', { hasText: org.admin.email }).click();
      const personDrawer = ui.drawer(admin.page);
      await expect(personDrawer).toContainText(org.admin.name);
      await button(personDrawer, 'Grant role').click();
      const grant = ui.modal(admin.page);
      await grant.locator('[name="ms"]').selectOption(org.system.slug);
      await grant.locator('[name="role"]').selectOption({ label: 'Management System Manager' });
      await grant.locator('[name="isPrimary"]').check();
      await expect(grant).toContainText(`Who can approve: ${org.second.name}`);
      await button(grant, 'Grant role').click();
      await expectToast(admin.page, 'Role grant waiting for approval');
      await closeLayers(admin.page);

      await reloadApp(second);
      await go(second, 'Pending approvals');
      const waiting = second.page.locator('main [data-approvals="grants"] tbody tr', { hasText: org.admin.name });
      await button(waiting, 'Approve').click();
      await expectToast(second.page, `Management System Manager in ${org.system.code} for ${org.admin.name} approved`);

      // With its manager in place, the system starts implementing.
      await reloadApp(admin);
      await go(admin, 'Management systems');
      await expect(row).toContainText(org.admin.name);
      await button(row, 'Start implementation').click();
      const start = ui.modal(admin.page);
      await expect(start).toContainText(`${org.system.code} moves from setup to implementing.`);
      await expectOverlayReadable(admin.page, `Start implementation (${org.slug})`);
      await button(start, 'Start implementation').click();
      await expectToast(admin.page, `${org.system.code} is implementing`);
      await expect(row).toContainText('Implementing');
    });

    test(`${org.key}: the manager uploads a file into the Managed Vault as evidence`, async ({ browser }) => {
      const admin = await person(browser, org.admin.key);
      await reloadApp(admin);
      await go(admin, 'Evidence freshness', { ms: org.system.code });
      await ui.pageAction(admin.page, 'New evidence').click();
      const dialog = ui.modal(admin.page);
      await expect(dialog).toContainText('New evidence');
      await dialog.locator('input[name="title"]').fill(`${org.system.code} scope and policy record`);
      await dialog.locator('select[name="frequencyCode"]').selectOption('quarterly');
      const target = org.system.target;
      await dialog.locator('input[type="search"]').first().fill(target);
      await dialog.locator('[role="option"]').filter({ hasText: target }).first().click();
      await button(dialog, 'Create evidence').click();
      await expect(dialog).toContainText('Attach the first file');
      await button(dialog, 'Choose file').click();
      const upload = ui.modal(admin.page);
      await expect(upload).toContainText('Managed Vault: the file is uploaded, versioned and SHA-256 checksummed by the application.');
      const file = evidenceFile(org);
      const chooser = admin.page.waitForEvent('filechooser');
      const stored = admin.page.waitForResponse((r) => /\/api\/v1\/storage\/upload-intents\/[^/]+\/content$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT');
      await button(upload, 'Upload to Managed Vault').click();
      await (await chooser).setFiles(file);
      const put = await stored;
      expect(put.status(), await put.text()).toBe(200);
      const body = await put.json();
      const result = body.data ?? body;
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      expect(result.hashValue, 'the vault records the SHA-256 of the file').toBe(sha256);
      await expectToast(admin.page, `${file.name} attached`);
      found[org.key] = { file, sha256, upload: result };
    });
  }

  test('Alpha\'s manager starts an export of the readiness report', async ({ browser }) => {
    const ayu = await person(browser, ALPHA.admin.key);
    await go(ayu, 'Overview', { ms: ALPHA.system.code });
    const queued = ayu.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/exports' && r.request().method() === 'POST');
    const download = ayu.page.waitForEvent('download', { timeout: 120_000 });
    await ui.pageAction(ayu.page, 'Readiness report').click();
    const answer = await queued;
    expect(answer.status(), await answer.text()).toBe(202);
    const body = await answer.json();
    const taskId = (body.data ?? body).taskId;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    // The worker builds the report; the app opens it as a download once it is ready.
    const file = await download;
    expect(file.url()).toContain(`/api/v1/exports/${taskId}/download`);
    found.export = { taskId };
  });

  test('isolation: Beta\'s administrator gets 404 for Alpha\'s system, file and export URLs; discovery answers an unknown slug like a known one', async ({ browser }) => {
    const ayu = await person(browser, ALPHA.admin.key);
    const budi = await person(browser, BETA.admin.key);
    const alphaFile = found.alpha.upload.storageObjectId;
    const betaFile = found.beta.upload.storageObjectId;
    const { taskId } = found.export;
    // Alpha's own URLs, as Alpha's manager opens them: the targets exist and answer.
    const own = [
      `/api/v1/ui/ms/${ALPHA.system.slug}`,
      `/api/v1/ms/${ALPHA.system.slug}/applicability`,
      `/api/v1/storage/objects/${alphaFile}/content?ms=${ALPHA.system.slug}`,
      `/api/v1/ms/${ALPHA.system.slug}/applicability/export?format=csv`,
      `/api/v1/exports/${taskId}/download`,
    ];
    for (const url of own) {
      const res = await ayu.page.request.get(url);
      expect(res.status(), `Alpha's manager GET ${url}`).toBe(200);
    }
    const content = await ayu.page.request.get(`/api/v1/storage/objects/${alphaFile}/content?ms=${ALPHA.system.slug}`);
    expect(createHash('sha256').update(await content.body()).digest('hex'), 'the stored file is the uploaded file').toBe(found.alpha.sha256);

    // The same URLs in the browser of Beta's manager, signed in to Beta: every one answers 404, as for a record
    // that does not exist, also when the file is asked for on behalf of Beta's own system.
    const foreign = [
      ...own,
      `/api/v1/storage/objects/${alphaFile}/content?ms=${BETA.system.slug}`,
      `/api/v1/storage/objects/${alphaFile}/open?ms=${BETA.system.slug}`,
      `/api/v1/exports/${taskId}`,
    ];
    await expecting(foreign.map((url) => ({ who: BETA.admin.key, status: 404, method: 'GET', path: new RegExp(`^${esc(url)}$`) })), async () => {
      for (const url of foreign) {
        const res = await budi.page.goto(url);
        expect(res.status(), `Beta's manager opens ${url}`).toBe(404);
        expect(await res.json(), `the answer of ${url} names no record`).toMatchObject({ status: 404, type: expect.stringContaining('not-found') });
        expect(res.headers()['content-security-policy']).toContain('sandbox');
      }
    });
    // Beta's own file opens for Beta's manager.
    const mine = await budi.page.request.get(`/api/v1/storage/objects/${betaFile}/content?ms=${BETA.system.slug}`);
    expect(mine.status()).toBe(200);
    expect(createHash('sha256').update(await mine.body()).digest('hex')).toBe(found.beta.sha256);
    await reloadApp(budi);

    // Discovery: a stranger's sign-in page with an unknown slug gets the same answer as with a known one.
    const stranger = await person(browser, 'stranger');
    const answers = [];
    for (const org of ['zz_unknown_org', BETA.slug, ALPHA.slug]) {
      const lookup = stranger.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/providers' && new URL(r.url()).searchParams.get('org') === org);
      await stranger.page.goto(`/login?org=${org}`);
      const res = await lookup;
      answers.push({ org, status: res.status(), body: await res.text(), cache: res.headers()['cache-control'] });
    }
    for (const a of answers.slice(1)) {
      expect({ status: a.status, body: a.body, cache: a.cache }, `discovery of ${a.org} answers as for an unknown slug`).toEqual({ status: answers[0].status, body: answers[0].body, cache: answers[0].cache });
    }
    expect(answers[0].status).toBe(200);
    await expect(stranger.page.locator('#au-email')).toBeVisible();
  });

  test('suspending Beta ends its sessions and sign-in shows the inactive message; Alpha keeps working; Beta is reactivated', async ({ browser }) => {
    const op = await person(browser, 'operator');
    // The suspension ends the sessions of Beta's people: from now on a page of theirs that is still open gets 401 at
    // its next read (the notification bell reads every minute) and shows the sign-in page.
    expectedNow.push({ who: [BETA.admin.key, BETA.second.key], status: 401, method: 'GET', path: /^\/api\/v1\// });
    const moved = await moveStatus(op, BETA, 'Suspend', 'Invoice overdue for 30 days; access is paused until payment');
    expect((moved.data ?? moved).sessionsRevoked).toBeGreaterThan(0);
    await waitForMail(BETA.admin.email, /suspend/i);

    // Beta's session has ended: the next page load shows the sign-in page. Sign-in itself still works (a person may
    // belong to other organisations, so the account is not locked), and every page of Beta is then refused with the
    // inactive message.
    const budi = await person(browser, BETA.admin.key);
    await budi.page.goto('/');
    await expect(budi.page).toHaveURL(/\/login/);
    await expect(budi.page.locator('#au-email')).toBeVisible();
    // While Beta is suspended, every read of Budi's signed-in pages answers 403 organisation-inactive, until the
    // reactivation and "Try again".
    await expecting([{ who: BETA.admin.key, status: 403, method: 'GET', path: /^\/api\/v1\// }], async () => {
      inactiveFor = BETA.admin.key;
      try {
        const refused = budi.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ui/org');
        await passwordAndCode(budi);
        const answer = await refused;
        expect(answer.status()).toBe(403);
        expect(await answer.json()).toMatchObject({ type: expect.stringContaining('organisation-inactive') });
        for (const text of INACTIVE) await expect(budi.page.locator(PANEL_SCOPE.replace(' *', '')).getByText(text)).toBeVisible();
        await expectReadableText(budi.page, 'the inactive message after sign-in', PANEL_SCOPE);
        await budi.page.waitForLoadState('networkidle');
      } finally {
        inactiveFor = null;
      }

      const ayu = await person(browser, ALPHA.admin.key);
      await reloadApp(ayu);
      await go(ayu, 'Evidence freshness', { ms: ALPHA.system.code });
      expect((await ayu.page.request.get(`/api/v1/ui/ms/${ALPHA.system.slug}`)).status()).toBe(200);

      // Reactivated: the message's "Try again" opens Beta as it was.
      await moveStatus(op, BETA, 'Reactivate', 'Payment received; access restored');
      await budi.page.getByRole('button', { name: 'Try again' }).click();
      await expect(ui.title(budi.page).first()).toBeVisible();
      await settle(budi.page);
      await budi.page.waitForLoadState('networkidle');
    });
    expect((await budi.page.request.get(`/api/v1/ui/ms/${BETA.system.slug}`)).status()).toBe(200);
  });

  test('offboarding Beta: reads work, writes answer 403', async ({ browser }) => {
    const op = await person(browser, 'operator');
    await moveStatus(op, BETA, 'Start offboarding', 'Contract ended on request of the customer; read-only period started');
    const budi = await person(browser, BETA.admin.key);
    await reloadApp(budi);
    await go(budi, 'Evidence freshness', { ms: BETA.system.code });
    expect((await budi.page.request.get(`/api/v1/ui/ms/${BETA.system.slug}`)).status()).toBe(200);
    expect((await budi.page.request.get(`/api/v1/storage/objects/${found.beta.upload.storageObjectId}/content?ms=${BETA.system.slug}`)).status()).toBe(200);

    await go(budi, 'People and roles');
    await ui.pageAction(budi.page, 'Invite person').click();
    const dialog = ui.modal(budi.page);
    await dialog.locator('[name="email"]').fill('dewi.anggraini@betamandiri.co.id');
    await dialog.locator('[name="displayName"]').fill('Dewi Anggraini');
    const answer = await expecting([{ who: BETA.admin.key, status: 403, method: 'POST', path: /^\/api\/v1\/admin\/users$/ }], async () => {
      const refused = budi.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/admin/users' && r.request().method() === 'POST');
      await button(dialog, 'Send invitation').click();
      return refused;
    });
    expect(answer.status()).toBe(403);
    expect(await answer.json()).toMatchObject({ type: expect.stringContaining('organisation-inactive') });
    await expectOverlayReadable(budi.page, 'the refused invitation of an organisation in offboarding');
    await closeLayers(budi.page);
  });

  test('the operator lowers Alpha\'s user limit to its current use; the next invitation shows the LIC-USERS message', async ({ browser }) => {
    const op = await person(browser, 'operator');
    const { page } = op;
    await operatorOrganisations(op);
    await expect(orgRow(page, ALPHA)).toContainText('2 of 50');
    const drawer = await manage(op, ALPHA, 'Entitlements');
    const form = drawer.locator('[data-entitlement-form]');
    await form.getByLabel(/^Plan preset/).selectOption('');
    await form.getByLabel(/^Plan name/).fill('Alpha contract 2026');
    await form.getByLabel(/^Users/).fill('2');
    await expectOverlayReadable(page, 'the custom limits of Alpha');
    await button(form, 'Save the entitlement').click();
    await expectToast(page, `Entitlement of ${ALPHA.name} saved`);
    await closeLayers(page);
    await expect(orgRow(page, ALPHA)).toContainText('2 of 2');

    const ayu = await person(browser, ALPHA.admin.key);
    await go(ayu, 'People and roles');
    await ui.pageAction(ayu.page, 'Invite person').click();
    const dialog = ui.modal(ayu.page);
    await dialog.locator('[name="email"]').fill(ALPHA.extra.email);
    await dialog.locator('[name="displayName"]').fill(ALPHA.extra.name);
    await dialog.locator('[name="jobTitle"]').fill(ALPHA.extra.jobTitle);
    // LIC-USERS is a business rule: 422 (D-15).
    const answer = await expecting([{ who: ALPHA.admin.key, status: 422, method: 'POST', path: /^\/api\/v1\/admin\/users$/ }], async () => {
      const refused = ayu.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/admin/users' && r.request().method() === 'POST');
      await button(dialog, 'Send invitation').click();
      return refused;
    });
    expect(answer.status()).toBe(422);
    expect(await answer.json()).toMatchObject({ rule: 'LIC-USERS' });
    await expect(dialog).toContainText('The user limit is reached');
    await expect(dialog).toContainText('Ask your MSCD service provider for a plan with more users.');
    await expectOverlayReadable(ayu.page, 'the LIC-USERS message');
    await closeLayers(ayu.page);
    for (const s of sessions.values()) await expectEssentialCookies(s);
  });
});
