// Fresh-organisation journey (MILESTONE-2 M2-18): a customer organisation without demo data runs its ISO/IEC 27001
// programme in the browser, from the first administrator's invitation to the certificate. run-journey.mjs starts the
// stack and runs the installer step; every step here happens on screen, each person in their own browser session.
// The journey fails on any page error, console error or 5xx answer, and checks the readability of every new screen.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { KEYCLOAK_PASSWORD, LOCAL_PASSWORD, addDays } from '../lib/journey-data.mjs';
import { smokeSettings } from '../lib/settings.mjs';
import { signLicence } from '../lib/licence.mjs';
import { linkFor } from '../lib/mailpit.mjs';
import { PANEL_SCOPE, expectOverlayReadable, expectReadableText } from '../lib/readable.mjs';
import { codeOf, secondsLeftInStep } from '../lib/totp.mjs';

if (!process.env.JOURNEY_STATE) throw new Error('JOURNEY_STATE is not set: run the journey with npm run journey -w @mscd/smoke (run-journey.mjs starts the stack first)');
const state = JSON.parse(readFileSync(process.env.JOURNEY_STATE, 'utf8'));
const SAAS = state.variant === 'saas';
const { people: P, organisation: ORG } = state;
const DAY0 = state.today;
/** The company sign-in the first administrator adds: the development Keycloak of the stack. */
const KEYCLOAK_SLUG = 'keycloak';
const KEYCLOAK_ISSUER = 'http://keycloak:18088/realms/mscd';
/** The client of MSCD in the development realm (deploy/compose/config/demo-secrets/keycloak-client.secret). */
const KEYCLOAK_CLIENT_SECRET = 'mscd-dev-oidc-secret';
const ISMS_SCOPE = 'Managed IT services and software development at the Jakarta head office and the Surabaya data centre';
const CERTIFICATION_BODY = 'PT Sertifikasi Mutu Nusantara';
/** The email domain of the people of the organisation (the development Keycloak realm sends these addresses). */
const DOMAIN = 'nusantaradigital.co.id';
// The certification audits are planned ahead; the journey later moves the server date past them (travel).
const STAGE1 = addDays(DAY0, 14);
const STAGE2 = addDays(DAY0, 28);
const INTERNAL_AUDIT = addDays(DAY0, 7);
/** The server date after the time the journey lets pass: after the Stage 2 audit. */
const LATER = addDays(DAY0, 35);
const CERTIFICATE_NO = 'ISMS-27001-0001';

// What the journey remembers between its steps: the authenticator secrets the people enrolled (a person's phone).
const memoryFile = path.join(state.stateDir, 'memory.json');
const memory = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')) : { secrets: {}, visited: [] };
const remember = () => writeFileSync(memoryFile, JSON.stringify(memory, null, 2), { mode: 0o600 });

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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An ISO date as the screens show it in English, for example 12 Nov 2026. */
const dmy = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^\\s*${esc(name)}\\s*$`) });

/** A one-page PDF of the information security policy, the file its author uploads as the first version of POL-01. */
function policyPdf() {
  const text = 'BT /F1 14 Tf 72 760 Td (POL-01 Information security policy, PT Nusantara Mitra Solusi) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---- people and their browser sessions ----
const sessions = new Map();
const problems = [];
/** True while the journey restarts api and worker (travelTo): answers of that moment are not counted. */
let paused = false;

/** Records page errors, console errors and 5xx answers of a person's page (the journey fails on any of them). */
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who}: pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The browser logs every 4xx answer as "Failed to load resource" (a sign-in page asks GET /me first, for example);
    // the answers the app expects are not errors of the app. A 5xx is counted by the response listener below.
    if (/^Failed to load resource: the server responded with a status of [1-4]\d\d/.test(text)) return;
    if (/^Failed to load resource: the server responded with a status of 5\d\d/.test(text)) return;
    problems.push(`${who}: console.error: ${text}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500 && !paused) problems.push(`${who}: ${r.status()} ${r.request().method()} ${r.url()}`);
  });
}
/** The browser session of a person (one context each, kept for the whole journey). */
async function person(browser, key) {
  if (sessions.has(key)) return sessions.get(key);
  const context = await browser.newContext();
  const page = await context.newPage();
  watch(page, key);
  const s = { key, who: P[key] ?? state.operator, context, page };
  sessions.set(key, s);
  return s;
}

/**
 * Checks the readability of a screen the person sees for the first time (the sign-in pages, the landing screens);
 * `go` does the same for the screens of the sidebar.
 */
async function firstVisit(s, screen, scope) {
  const key = `${s.key}:${screen}`;
  if (memory.visited.includes(key)) return;
  await expectReadableText(s.page, `${screen} (${s.key})`, scope);
  memory.visited.push(key);
  remember();
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
  memory.secrets[s.key] = secret;
  remember();
  await expectReadableText(page, `the enrolment page of ${s.key}`);
  await freshStep(page);
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
  if (memory.lastStep?.[s.key] === step) await page.waitForTimeout((step + 1) * 30_000 - Date.now() + 400);
  memory.lastStep = { ...memory.lastStep, [s.key]: Math.floor(Date.now() / 30_000) };
  remember();
  return codeOf(memory.secrets[s.key]);
}

/** The second-factor page after a password or a company sign-in. */
async function secondFactor(s) {
  const { page } = s;
  await expect(page).toHaveURL(/\/login\/mfa/);
  await expect(page.locator('#au-code')).toBeVisible();
  await firstVisit(s, 'the second-factor page');
  await page.locator('#au-code').fill(await totpCode(s));
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/** Keycloak's own sign-in form (the company sign-in of the journey). */
async function keycloakForm(s) {
  const { page } = s;
  await expect(page).toHaveURL(/^http:\/\/keycloak:\d+\/realms\/mscd\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill(s.who.keycloak);
  await page.locator('#password').fill(KEYCLOAK_PASSWORD);
  await page.locator('#kc-login').click();
}

/**
 * A session for a person who enrolled earlier in the journey: a local account signs in with its password, a member of
 * the team through company sign-in; both then give the authenticator code.
 */
async function signIn(s) {
  const { page } = s;
  await page.goto('/');
  // The app boots, then shows the screen of a live session or moves to the sign-in page.
  await expect(page.locator('main h1, #au-email').first()).toBeVisible();
  if (!/\/login/.test(page.url())) return;
  await firstVisit(s, 'the sign-in page');
  if (s.who.keycloak) {
    await page.locator(`a.au-sso-btn[data-provider="${KEYCLOAK_SLUG}"]`).click();
    if (/\/realms\//.test(page.url())) await keycloakForm(s);
  } else {
    await page.locator('#au-email').fill(s.who.email);
    await page.locator('#au-password').fill(LOCAL_PASSWORD);
    await page.locator('.au-form button[type="submit"]').click();
  }
  await secondFactor(s);
}

/** A person's page, signed in. */
async function as(browser, key) {
  const s = await person(browser, key);
  if (s.page.url() === 'about:blank') {
    await signIn(s);
    await s.page.waitForLoadState('networkidle');
  }
  return s;
}

/**
 * Loads the app again, as a person does after an administrator changed their roles: the shell reads the person's
 * systems and screens when it starts. It waits for the reads of the page before, so none is cut off.
 */
async function reloadApp(s) {
  await s.page.waitForLoadState('networkidle');
  await s.page.goto('/');
  await expect(s.page.locator('main h1').first()).toBeVisible();
  await s.page.waitForLoadState('networkidle');
}

/** Accepts an emailed invitation with a new password (local account) and enrols the authenticator. */
async function acceptLocally(s) {
  const { page } = s;
  await page.goto(await linkFor(s.who.email));
  await expect(page.locator('#au-new-password')).toBeVisible();
  await firstVisit(s, 'the invitation page');
  await page.locator('#au-new-password').fill(LOCAL_PASSWORD);
  await page.locator('#au-repeat-password').fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Set password and continue' }).click();
  await enrol(s);
}

/** Accepts an emailed invitation through company sign-in (Keycloak), then enrols the MSCD authenticator (F.5 fallback). */
async function acceptWithCompanySignIn(s) {
  const { page } = s;
  await page.goto(await linkFor(s.who.email));
  const sso = page.locator(`a.au-sso-btn[data-provider="${KEYCLOAK_SLUG}"]`);
  if (SAAS) {
    // A service with several organisations lists the company sign-in of the organisation of the person's email
    // domain, which the platform operator verified (M2-S11).
    await expect(page.locator('#au-new-password')).toBeVisible();
    await firstVisit(s, 'the invitation page');
    await page.getByRole('button', { name: 'Find the sign-in of my organisation' }).click();
    await expect(page.locator('#au-lookup-email')).toBeVisible();
    await firstVisit(s, 'the sign-in lookup of the invitation page');
    await page.locator('#au-lookup-email').fill(s.who.email);
    await page.getByRole('button', { name: 'Find the sign-in of my organisation' }).click();
  }
  await expect(sso).toBeVisible();
  await firstVisit(s, 'the invitation page with company sign-in');
  await sso.click();
  await keycloakForm(s);
  await enrol(s);
}

/** Runs a command in a service of the journey stack (`docker compose exec`); returns its output. */
function composeExec(service, args) {
  const { project, files, env } = state.compose;
  const r = spawnSync('docker', ['compose', '-p', project, '--env-file', '/dev/null', ...files.flatMap((f) => ['-f', f]), 'exec', '-T', service, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  expect(r.status, `docker compose exec ${service}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** Publishes a TXT record in the DNS of the provider mocks, as the customer's IT team adds it to their domain. */
function publishTxt(name, value) {
  const script = `const r = await fetch('http://127.0.0.1:4310/_admin/dns/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ name, values: [value] })}) }); if (!r.ok) { process.stderr.write(String(r.status) + ' ' + await r.text()); process.exit(1); }`;
  composeExec('mock-providers', ['node', '--input-type=module', '-e', script]);
}

/**
 * Moves the server date forward (journey.yml: demo.fixed_today), as weeks pass between an implementation and its
 * effectiveness check (BR-08) and until the Stage 2 audit has taken place. api and worker are recreated with the new
 * date; the pages are closed first, so no request of theirs meets the restart, and opened again afterwards with their
 * sessions (kept in the database).
 */
async function travelTo(day) {
  for (const s of sessions.values()) {
    await s.page.waitForLoadState('networkidle').catch(() => {});
    await s.page.goto('about:blank');
  }
  paused = true;
  try {
    const { project, files, env } = state.compose;
    const args = ['compose', '-p', project, '--env-file', '/dev/null', ...files.flatMap((f) => ['-f', f]), 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '300', 'api', 'worker'];
    const r = spawnSync('docker', args, { env: { ...process.env, ...env, JOURNEY_TODAY: day }, encoding: 'utf8', timeout: 360_000 });
    expect(r.status, `docker compose up api worker with the date ${day}: ${r.stderr}`).toBe(0);
    // The web container resolves the api's new address again within 10 seconds (NGINX resolver valid=10s); until
    // then its answers may come from the old address. Wait until the api answers through it several times in a row.
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    let good = 0;
    for (let i = 0; i < 60 && good < 5; i += 1) {
      const res = await fetch(`${smokeSettings().baseUrl}/api/v1/system/profile`).catch(() => null);
      good = res?.ok ? good + 1 : 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(good, 'the api answers through the web container after the restart').toBe(5);
  } finally {
    paused = false;
  }
  memory.today = day;
  remember();
  for (const s of sessions.values()) {
    await s.page.goto('/');
    await expect(s.page.locator('main h1, #au-email').first()).toBeVisible();
    await s.page.waitForLoadState('networkidle');
  }
}

/**
 * Opens a screen from the sidebar, and checks the readability of every screen the journey visits for the first time
 * (per person, since each role sees other data and actions).
 */
async function go(s, label, { ms, fresh = false } = {}) {
  const { page } = s;
  await closeLayers(page);
  // The app keeps the snapshot it loaded and reloads it after the person's own changes; what another person changed
  // since shows after the app loads again, as when the person comes back to it later.
  if (fresh) await reloadApp(s);
  if (ms) await switchMs(page, ms);
  await ui.nav(page, label).click();
  await expect(ui.title(page)).toHaveText(label);
  await settle(page);
  const key = `${s.key}:${label}`;
  if (!memory.visited.includes(key)) {
    await expectReadableText(page, `${label} (${s.key})`);
    memory.visited.push(key);
    remember();
  }
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

/** Chooses a person in a select by the name its option shows. */
async function selectPerson(select, name) {
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  expect(value, `an option for ${name}`).toBeTruthy();
  await select.selectOption(value);
}

const list = (page) => page.locator('main input[placeholder^="Search"]').locator('xpath=../..');
const listRow = (page, text) => list(page).locator('tbody > tr[style*="cursor: pointer"]').filter({ hasText: text }).first();
const drawerAction = (page, label) => ui.drawer(page).locator(`button[title="${label}"]`);
const chips = (page) => list(page).locator('xpath=./div[1]/div[1]/button');
const chip = (page, label) => chips(page).filter({ hasText: new RegExp(`^\\s*${esc(label)}\\s*\\d+\\s*$`) });

async function search(page, text) {
  const box = page.locator('main input[placeholder^="Search"]');
  await box.fill(text);
}

async function openRow(page, text) {
  await listRow(page, text).click();
  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawer(page)).toContainText(text);
}

/** The value of an input the form fills in after it opened (a suggested code, for example). */
async function filledValue(input) {
  await expect(input).toHaveValue(/\S/);
  return input.inputValue();
}

async function expectToast(page, text) {
  await expect(ui.toast(page)).toContainText(text);
}

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  expect(problems, 'page errors, console errors and 5xx answers during the step').toEqual([]);
});

test.afterAll(async () => {
  for (const s of sessions.values()) await s.context.close().catch(() => {});
});

test.describe(SAAS ? 'Fresh organisation on SaaS' : 'Fresh organisation on-premise', () => {
  // The installer step on-premise (run-journey.mjs) invited the first administrator; on SaaS the platform operator
  // creates the organisation and installs its licence in the operator console.
  if (SAAS) {
    test('the platform operator sets a password from the emailed link and enrols an authenticator', async ({ browser }) => {
      const op = await person(browser, 'operator');
      const { page } = op;
      await page.goto(await linkFor(state.operator.email, 'reset'));
      await expect(page.locator('#au-new-password')).toBeVisible();
      await expectReadableText(page, 'the set-password page');
      await page.locator('#au-new-password').fill(LOCAL_PASSWORD);
      await page.locator('#au-repeat-password').fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Set password' }).click();
      await expect(page.locator('#au-email')).toBeVisible();
      await firstVisit(op, 'the sign-in page');
      await page.locator('#au-email').fill(state.operator.email);
      await page.locator('#au-password').fill(LOCAL_PASSWORD);
      await page.locator('.au-form button[type="submit"]').click();
      await enrol(op);
      await expect(ui.title(page)).toHaveText('Operator console');
      await settle(page);
      await expectReadableText(page, 'Operator console (operator)');
      memory.visited.push('operator:Operator console');
      remember();
    });

    test('the platform operator creates the organisation, installs its licence and verifies its email domain', async ({ browser }) => {
      const op = await person(browser, 'operator');
      const { page } = op;
      await page.locator('main [role="tab"]', { hasText: 'Organisations' }).click();
      await expect(page.locator('main')).toContainText('No organisation yet');
      await expectReadableText(page, 'the organisations of the operator console');
      await ui.pageAction(page, 'Create organisation').click();
      const dialog = ui.modal(page);
      await expect(dialog).toContainText('Create an organisation');
      await expect(dialog).toContainText('The slug cannot be changed after the organisation is created.');
      await dialog.getByLabel(/^Slug/).fill(ORG.slug);
      await dialog.getByLabel(/^Name/).fill(ORG.name);
      await dialog.getByLabel(/^Time zone/).selectOption(ORG.timeZone);
      await dialog.getByLabel(/^Number of sites/).fill(String(ORG.sites));
      await dialog.getByLabel(/^First administrator email/).fill(P.ana.email);
      await dialog.getByLabel(/^First administrator name/).fill(P.ana.name);
      await expectOverlayReadable(page, 'Create an organisation');
      // The answer names the new organisation's id, which its licence is bound to (D-15).
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ops/organizations' && r.request().method() === 'POST');
      await button(dialog, 'Create').click();
      const created = await (await answer).json();
      expect(created.data?.slug).toBe(ORG.slug);
      await expect(dialog).toContainText(`Organisation created. The slug ${ORG.slug} cannot be changed.`);
      await expect(dialog).toContainText(`The invitation was emailed to ${P.ana.email}.`);
      await expectOverlayReadable(page, 'the created organisation');
      await button(dialog, 'Close').click();
      const row = page.locator('main table tbody tr', { hasText: ORG.slug });
      await expect(row).toBeVisible();

      // The service provider signs the organisation's licence for its id; the operator installs it here, because the
      // licences belong to the platform operator on a service with several organisations.
      const licence = signLicence(state.stateDir, { orgId: created.data.id, orgName: ORG.name, today: DAY0 });
      await button(row, 'Install licence').click();
      const install = ui.modal(page);
      await expect(install).toContainText(`Install a licence for ${ORG.name}`);
      await install.locator('input[type="file"]').setInputFiles(licence);
      await expect(install.locator('textarea')).toHaveValue(/"license_id": "LIC-JOURNEY-/);
      await expectOverlayReadable(page, 'Install a licence for the organisation');
      await button(install, 'Install licence').click();
      await expectToast(page, `Licence of ${ORG.name} installed`);

      // The customer's email domain, so its people find the organisation and its company sign-in by their work email.
      await button(row, 'Manage').click();
      const drawer = ui.drawer(page);
      await expect(drawer).toContainText(ORG.name);
      await drawer.getByRole('tab', { name: 'Domains', exact: true }).click();
      await drawer.getByRole('button', { name: 'Add domain' }).click();
      const add = ui.modal(page);
      await add.locator('input').fill(DOMAIN);
      await add.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(add).toContainText(`The TXT record for ${DOMAIN}`);
      const text = await add.innerText();
      const value = text.match(/mscd-verify=[A-Za-z0-9_-]+/)?.[0];
      const name = text.match(new RegExp(`_[a-z0-9-]+\\.${esc(DOMAIN)}`))?.[0];
      expect(value, 'the TXT value shown once').toBeTruthy();
      expect(name, 'the TXT record name').toBeTruthy();
      await expectOverlayReadable(page, 'the TXT record');
      await add.getByRole('button', { name: 'Done' }).click();
      publishTxt(name, value);
      const domain = drawer.locator(`[data-domain="${DOMAIN}"]`);
      await domain.getByRole('button', { name: 'Verify now' }).click();
      await expect(drawer.locator('[data-domain-outcome]')).toContainText(`The record of ${DOMAIN} was found. The domain is verified.`);
      await expectOverlayReadable(page, 'the organisation drawer');
      await closeLayers(page);
      await expect(row).toContainText(DOMAIN);
    });

    test('the first administrator accepts the invitation; the Licence screen shows the licence without Install licence', async ({ browser }) => {
      const ana = await person(browser, 'ana');
      await acceptLocally(ana);
      await expect(ui.title(ana.page)).toHaveText('Getting started');
      await settle(ana.page);
      await expectReadableText(ana.page, 'Getting started (ana)');
      memory.visited.push('ana:Getting started');
      remember();
      await go(ana, 'Licence');
      const main = ana.page.locator('main');
      await expect(main).toContainText('Valid');
      await expect(main).toContainText(ORG.name);
      // The signed licence the operator installed replaces the plan the console chose when it created the organisation.
      await expect(main).toContainText('Signed licence file');
      await expect(ui.pageAction(ana.page, 'Install licence')).toHaveCount(0);
      await expect(main.locator('button', { hasText: 'Install licence' })).toHaveCount(0);
    });
  } else {
    test('the first administrator accepts the invitation and enrols an authenticator', async ({ browser }) => {
      const ana = await person(browser, 'ana');
      const link = await linkFor(P.ana.email);
      await ana.page.goto(link);
      await expect(ana.page.locator('#au-new-password')).toBeVisible();
      await firstVisit(ana, 'the invitation page');
      await ana.page.locator('#au-new-password').fill(LOCAL_PASSWORD);
      await ana.page.locator('#au-repeat-password').fill(LOCAL_PASSWORD);
      await ana.page.getByRole('button', { name: 'Set password and continue' }).click();
      await enrol(ana);
      await expect(ui.title(ana.page)).toHaveText('Getting started');
      await settle(ana.page);
      await expectReadableText(ana.page, 'Getting started (ana)');
      memory.visited.push('ana:Getting started');
      remember();
    });

    test('the first administrator installs the licence', async ({ browser }) => {
      const ana = await as(browser, 'ana');
      await go(ana, 'Licence');
      await expect(ana.page.locator('main')).toContainText('No licence installed');
      await ui.pageAction(ana.page, 'Install licence').click();
      const dialog = ui.modal(ana.page);
      await expect(dialog).toContainText('Install a licence');
      await dialog.locator('input[type="file"]').setInputFiles(state.licencePath);
      await expect(dialog.locator('textarea')).toHaveValue(/"license_id": "LIC-JOURNEY-/);
      await expectOverlayReadable(ana.page, 'Install a licence');
      await button(dialog, 'Install licence').click();
      await expectToast(ana.page, 'Licence installed');
      const main = ana.page.locator('main');
      await expect(main).toContainText('Valid');
      await expect(main).toContainText(ORG.name);
      await expect(main).toContainText('of 25 active members');
      await expectReadableText(ana.page, 'Licence with a licence');
    });
  }

  test('the first administrator invites a second administrator and the team; the second administrator joins', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    await go(ana, 'People and roles');
    const dialog = ui.modal(ana.page);
    const invite = async (p, { tenantAdmin = false, storageAdmin = false } = {}) => {
      await ui.pageAction(ana.page, 'Invite person').click();
      await expect(dialog).toContainText('Invite a person');
      await dialog.locator('[name="email"]').fill(p.email);
      await dialog.locator('[name="displayName"]').fill(p.name);
      await dialog.locator('[name="jobTitle"]').fill(p.jobTitle);
      if (tenantAdmin) await dialog.getByLabel('Tenant Admin').check();
      if (storageAdmin) await dialog.getByLabel('Storage Admin').check();
      await expectOverlayReadable(ana.page, `Invite ${p.name}`);
      await button(dialog, 'Send invitation').click();
      await expectToast(ana.page, `Invitation sent to ${p.email}`);
      await expect(dialog).toHaveCount(0);
      await expect(ana.page.locator('main table tbody tr', { hasText: p.email })).toContainText('Invited');
    };
    await invite(P.dewi, { tenantAdmin: true });
    await invite(P.rina);
    await invite(P.hendra);
    await invite(P.bagus, { storageAdmin: true });
    await invite(P.maya);

    const dewi = await person(browser, 'dewi');
    await acceptLocally(dewi);
    await expect(ui.title(dewi.page)).toHaveText('Getting started');
    await settle(dewi.page);
    await firstVisit(dewi, 'Getting started');
    await go(ana, 'Getting started');
    await expect(ana.page.locator('main li[data-step="second_admin"]')).toContainText('Administrators: 2');
    await go(ana, 'People and roles');
    await expect(ana.page.locator('main table tbody tr', { hasText: P.dewi.name })).not.toContainText('Invited');
  });

  test('the first administrator connects a SharePoint library and tests the connection', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    const sp = state.sharepoint;
    await go(ana, 'Storage repositories');
    await ui.pageAction(ana.page, 'Connect repository').click();
    const drawer = ui.drawer(ana.page);
    const field = (name) => drawer.locator(`[name="${name}"]`);
    await expect(drawer).toContainText('Step 1: Storage type');
    await drawer.getByLabel('Microsoft 365 (SharePoint or OneDrive)').check();
    await expectOverlayReadable(ana.page, 'Connect repository, step 1');
    await button(drawer, 'Next').click();
    await field('name').fill('SharePoint Compliance');
    await field('slug').fill('sharepoint');
    await field('tenantId').fill(sp.tenantId);
    await field('siteId').fill(sp.siteId);
    await field('driveId').fill(sp.driveId);
    await field('rootFolderId').fill(sp.rootFolderId);
    await drawer.getByLabel('Pass-through').check();
    await drawer.getByLabel(/^The retention settings/).check();
    await expectOverlayReadable(ana.page, 'Connect repository, step 2');
    await button(drawer, 'Save and continue').click();
    await expectToast(ana.page, 'Repository SharePoint Compliance saved');
    await expect(drawer).toContainText('Step 3 of 4: Credential');
    await expect(field('credential-tenantId')).toHaveValue(sp.tenantId);
    await field('credential-clientId').fill(sp.clientId);
    await field('credential-certificate').fill(sp.certificatePem);
    await field('credential-privateKey').fill(sp.privateKeyPem);
    await expectOverlayReadable(ana.page, 'Connect repository, step 3');
    await button(drawer, 'Save credential').click();
    await expectToast(ana.page, 'Credential saved and sealed');
    await expect(drawer).toContainText('Step 4 of 4: Test connection');
    await button(drawer, 'Test connection').click();
    await expect(drawer.locator('[role="status"]').filter({ hasText: 'Connected to' })).toContainText('Connected to Compliance');
    await expectOverlayReadable(ana.page, 'Connect repository, step 4');
    await button(drawer, 'Done').click();
    await expect(drawer).toHaveCount(0);
    await expect(ana.page.locator('main')).toContainText('SharePoint Compliance');
  });

  test('the first administrator adds a routing rule for confidential files', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    await go(ana, 'Routing rules');
    await expect(ana.page.locator('main')).toContainText('No routing rule yet');
    await ui.pageAction(ana.page, 'Add rule').click();
    const drawer = ui.drawer(ana.page);
    const select = (label) => drawer.getByLabel(new RegExp(`^${label}`));
    await expect(drawer).toContainText('Add a routing rule');
    // Confidential files of every management system are kept in the Managed Vault inside the installation; every
    // other file goes to the default repository of its system.
    await select('System').selectOption({ label: 'Whole organisation' });
    await select('Classification of the file').selectOption({ label: 'Confidential' });
    await select('Repository').selectOption({ label: 'Managed Vault' });
    await expect(select('Storage mode')).toHaveValue('stored');
    await drawer.locator('textarea[name="note"]').fill('Confidential files stay in the Managed Vault');
    await expectOverlayReadable(ana.page, 'Add a routing rule');
    await button(drawer, 'Save').click();
    await expect(drawer).toHaveCount(0);
    const rule = ana.page.locator('main table tbody tr', { hasText: 'Confidential files stay in the Managed Vault' });
    await expect(rule).toContainText('Active');
    await expect(rule).toContainText('Managed Vault');
  });

  test('the first administrator adds company sign-in and tests it; the team joins through it', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    await go(ana, 'Company sign-in');
    await expect(ana.page.locator('main')).toContainText('No company sign-in yet');
    await ui.pageAction(ana.page, 'Add OIDC provider').click();
    const drawer = ui.drawer(ana.page);
    const field = (name) => drawer.locator(`[name="${name}"]`);
    await field('displayName').fill('Sign in with Nusantara account');
    await field('slug').fill(KEYCLOAK_SLUG);
    await expect(drawer).toContainText(`/api/v1/auth/oidc/${KEYCLOAK_SLUG}/callback`);
    await field('issuer').fill(KEYCLOAK_ISSUER);
    await field('clientId').fill('mscd');
    await field('clientSecret').fill(KEYCLOAK_CLIENT_SECRET);
    await expectOverlayReadable(ana.page, 'Add an OpenID Connect provider');
    await button(drawer, 'Add provider').click();
    await expectToast(ana.page, 'Sign in with Nusantara account added. Test it before people use it.');
    await expect(drawer).toHaveCount(0);
    const provider = ana.page.locator('main table tbody tr', { hasText: 'Sign in with Nusantara account' });
    await expect(provider).toContainText('Enabled');
    await button(provider, 'Test').click();
    const dialog = ui.modal(ana.page);
    await expect(dialog).toContainText('The provider answered. These endpoints were found:');
    await expect(dialog).toContainText(`${KEYCLOAK_ISSUER}/protocol/openid-connect/auth`);
    await expectOverlayReadable(ana.page, 'the test of the provider');
    await button(dialog, 'Close').click();
    await expect(provider).toContainText(/Passed \d{1,2} \w+ \d{4}/);

    // The team accepts the invitations through the company sign-in: a real sign-in proves the provider works.
    for (const key of ['rina', 'hendra', 'bagus', 'maya']) {
      const member = await person(browser, key);
      await acceptWithCompanySignIn(member);
      if (key === 'bagus') {
        // A Storage Admin without a business role lands on the administration screens.
        await expect(ui.title(member.page)).toBeVisible();
        await settle(member.page);
        await firstVisit(member, await ui.title(member.page).innerText());
      } else {
        // The others see the full-page message until a Tenant Admin grants them a role.
        await expect(member.page.getByText('You hold no role in a management system of this organisation yet.')).toBeVisible();
        await firstVisit(member, 'the screen without a role', PANEL_SCOPE);
      }
    }
    await go(ana, 'Getting started');
    await expect(ana.page.locator('main li[data-step="sign_in"]')).toContainText('Done');
    await expect(ana.page.locator('main li[data-step="team"]')).toContainText('Done');
  });

  test('the first administrator limits local sign-in to administrators', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    await go(ana, 'Company sign-in');
    const policy = ana.page.locator('main section', { hasText: 'Local sign-in' });
    await expect(policy.getByLabel('Everyone')).toBeChecked();
    await policy.getByLabel('Administrators only (Tenant Admins and Storage Admins)').check();
    await expect(policy).toContainText('Test company sign-in first.');
    await expectReadableText(ana.page, 'Company sign-in with the policy warning');
    await button(policy, 'Save policy').click();
    await expectToast(ana.page, 'Local sign-in policy saved');
    await go(ana, 'Getting started');
    await expect(ana.page.locator('main li[data-step="local_login"]')).toContainText('Done');
  });

  test('the first administrator creates the ISO/IEC 27001 system with its scope, body and default repository', async ({ browser }) => {
    const ana = await as(browser, 'ana');
    await go(ana, 'Management systems');
    await expect(ana.page.locator('main')).toContainText('No management system yet');
    await ui.pageAction(ana.page, 'New management system').click();
    const drawer = ui.drawer(ana.page);
    const field = (name) => drawer.locator(`[name="${name}"]`);
    await field('code').fill('ISMS');
    await expect(field('slug')).toHaveValue('isms');
    await field('name').fill('Information security management system');
    await drawer.locator('select').first().selectOption('ISO27001-2022');
    await expect(drawer).toContainText('Installed');
    await field('scopeStatement').fill(ISMS_SCOPE);
    await field('certificationBody').fill(CERTIFICATION_BODY);
    await drawer.getByLabel('Teal').check();
    // The ISMS starts in the Managed Vault: until its folder in the SharePoint library is set (10.3 of the install
    // guide), new files of the system are uploaded from the browser. The system moves to the library later.
    await drawer.locator('select').last().selectOption({ label: 'Managed Vault' });
    await expectOverlayReadable(ana.page, 'New management system');
    await button(drawer, 'Save').click();
    await expectToast(ana.page, /ISMS created/);
    const row = ana.page.locator('main table tbody tr', { hasText: 'ISO/IEC 27001' });
    await expect(row).toContainText('Setup');
    await expect(row).toContainText('Managed Vault');
    await expect(row).toContainText('Not assigned');
  });

  // The SaaS variant ends with the creation of the management system; on-premise the programme runs to the certificate.
  if (!SAAS) {
    test('the first administrator grants the roles; the grant to an administrator waits for the second administrator', async ({ browser }) => {
      const ana = await as(browser, 'ana');
      await go(ana, 'People and roles');
      const drawer = ui.drawer(ana.page);
      const dialog = ui.modal(ana.page);
      const grant = async (p, role, { primary = false, waits = false } = {}) => {
        await closeLayers(ana.page);
        await ana.page.locator('main table tbody tr', { hasText: p.email }).click();
        await expect(drawer).toContainText(p.name);
        await button(drawer, 'Grant role').click();
        await expect(dialog).toContainText(`Grant a role to ${p.name}`);
        await dialog.locator('[name="ms"]').selectOption('isms');
        await dialog.locator('[name="role"]').selectOption({ label: role });
        if (primary) await dialog.locator('[name="isPrimary"]').check();
        if (waits) await expect(dialog).toContainText(`Who can approve: ${P.dewi.name}`);
        await expectOverlayReadable(ana.page, `Grant ${role} to ${p.name}`);
        await button(dialog, 'Grant role').click();
        await expectToast(ana.page, waits ? 'Role grant waiting for approval' : 'Role granted');
        await expect(dialog).toHaveCount(0);
        await expect(drawer.locator('[data-grants]')).toContainText(`${role} in ISMS`);
      };
      await grant(P.rina, 'Management System Manager', { primary: true });
      await grant(P.hendra, 'Top Management');
      await grant(P.hendra, 'Programme Owner');
      await grant(P.maya, 'Internal Auditor');
      await grant(P.bagus, 'Domain Owner', { waits: true });
      await closeLayers(ana.page);
      await expect(ana.page.locator('main')).toContainText('1 role grant is waiting for the approval of a second Tenant Admin.');
      await expect(ui.nav(ana.page, 'Pending approvals')).toContainText('1');

      const dewi = await as(browser, 'dewi');
      await go(dewi, 'Pending approvals');
      const waiting = dewi.page.locator('main [data-approvals="grants"] tbody tr', { hasText: P.bagus.name });
      await expect(waiting).toContainText('Domain Owner, ISMS');
      await button(waiting, 'Approve').click();
      await expectToast(dewi.page, `Domain Owner in ISMS for ${P.bagus.name} approved`);
      await expect(dewi.page.locator('main')).toContainText('Nothing is waiting for approval');
    });

    test('the first administrator starts the implementation', async ({ browser }) => {
      const ana = await as(browser, 'ana');
      await go(ana, 'Management systems');
      const row = ana.page.locator('main table tbody tr', { hasText: 'ISO/IEC 27001' });
      await expect(row).toContainText(P.rina.name);
      await button(row, 'Start implementation').click();
      const dialog = ui.modal(ana.page);
      await expect(dialog).toContainText('ISMS moves from setup to implementing.');
      await expectOverlayReadable(ana.page, 'Start implementation');
      await button(dialog, 'Start implementation').click();
      await expectToast(ana.page, 'ISMS is implementing');
      await expect(row).toContainText('Implementing');
    });

    test('the Management System Manager plans the Stage 1 and Stage 2 audits', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      // Her roles were granted after she signed in: the app is loaded again and opens the portfolio of her system.
      await reloadApp(rina);
      await go(rina, 'Certification timeline');
      const dialog = ui.modal(rina.page);
      const plan = async (type, label, date, lead) => {
        await ui.pageAction(rina.page, 'Add audit event').click();
        await expect(dialog).toContainText('Add audit event');
        await dialog.locator('select[name="eventType"]').selectOption(type);
        await expect(dialog.locator('input[name="shortLabel"]')).toHaveValue(label);
        await dialog.locator('input[name="scheduledAt"]').fill(date);
        await dialog.locator('input[name="auditDays"]').fill('2');
        await dialog.locator('input[name="leadAuditor"]').fill(lead);
        await expectOverlayReadable(rina.page, `Add audit event ${label}`);
        await button(dialog, 'Add audit event').click();
        await expectToast(rina.page, `Audit event ${label} added`);
        await expect(dialog).toHaveCount(0);
      };
      await plan('stage1', 'Stage 1', STAGE1, 'Dr. Lestari Wibowo');
      await plan('stage2', 'Stage 2', STAGE2, 'Dr. Lestari Wibowo');
      await expect(rina.page.locator(`main button[title="Stage 1, ${dmy(STAGE1)}"]`)).toHaveCount(1);
      await expect(rina.page.locator(`main button[title="Stage 2, ${dmy(STAGE2)}"]`)).toHaveCount(1);
    });

    test('Getting started shows every step done', async ({ browser }) => {
      const ana = await as(browser, 'ana');
      await go(ana, 'Getting started');
      const main = ana.page.locator('main');
      await expect(main.locator('.mx-gs-progress')).toHaveText('Every step is done');
      await expect(main.locator('li[data-step][data-state="pending"]')).toHaveCount(0);
      for (const step of ['licence', 'second_admin', 'sign_in', 'local_login', 'repository', 'routing', 'systems', 'team', 'ms_manager', 'verifiers', 'internal_auditor', 'implementing', 'applicability', 'audit_dates', 'pending_grants']) {
        await expect(main.locator(`li[data-step="${step}"]`).first()).toContainText('Done');
      }
      await expectReadableText(ana.page, 'Getting started with every step done');
    });

    test('the Management System Manager records a risk with a treatment; the risk owner accepts the residual risk', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      await go(rina, 'Registers');
      await rina.page.locator('main [role="tab"]', { hasText: /^Risks$/ }).click();
      await ui.pageAction(rina.page, 'Add record').click();
      const drawer = ui.drawer(rina.page);
      await expect(drawer).toContainText('Add to Risks');
      const code = await filledValue(drawer.getByLabel(/^ID/));
      expect(code).toMatch(/^R-\d+$/);
      memory.riskCode = code;
      remember();
      await drawer.getByLabel(/^Title/).fill('Unauthorised access to customer data in the ticketing system');
      await selectPerson(drawer.locator('select[name="ownerHandle"]'), P.hendra.name);
      await drawer.locator('select[name="likelihood"]').selectOption('3');
      await drawer.locator('select[name="consequence"]').selectOption('4');
      await expectOverlayReadable(rina.page, 'Add a risk');
      await button(drawer, 'Save').click();
      await expectToast(rina.page, `${code} added`);
      await search(rina.page, code);
      await listRow(rina.page, code).click();
      await expect(drawer).toContainText('No treatment yet.');
      await button(drawer, 'Add treatment').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText(`Add a treatment to ${code}`);
      await expect(dialog.locator('input[type="search"]')).toBeVisible();
      const treatment = await filledValue(dialog.getByLabel(/^Treatment ID/));
      await dialog.getByLabel(/^What will be done/).fill('Role-based access with a quarterly access review of the ticketing system');
      await selectPerson(dialog.locator('select[name="treatmentOwner"]'), P.rina.name);
      await dialog.getByLabel(/^Due date/).fill(addDays(DAY0, 21));
      await dialog.locator('input[type="search"]').fill('A.5.15');
      await dialog.locator('[role="option"]').first().click();
      await expectOverlayReadable(rina.page, 'Add a treatment');
      await button(dialog, 'Add treatment').click();
      await expectToast(rina.page, `${treatment} added to ${code}`);
      const row = drawer.locator(`[data-treatment="${treatment}"]`);
      await expect(row).toContainText('Proposed');
      await button(row, 'Approve').click();
      await expect(row).toContainText('Approved');
      await button(row, 'Start').click();
      await expect(row).toContainText('In progress');
      await button(row, 'Mark implemented').click();
      await expect(row).toContainText('Implemented');
      await expect(drawer).toContainText(`Only the risk owner, ${P.hendra.name}, can accept the residual risk.`);

      // The risk owner, who did not implement the treatment, accepts the residual risk (BR-04).
      const hendra = await as(browser, 'hendra');
      await go(hendra, 'Registers', { fresh: true });
      await hendra.page.locator('main [role="tab"]', { hasText: /^Risks$/ }).click();
      await listRow(hendra.page, code).click();
      const hDrawer = ui.drawer(hendra.page);
      await button(hDrawer, 'Accept residual risk').click();
      const hDialog = ui.modal(hendra.page);
      await expect(hDialog).toContainText(`Accept the residual risk of ${code}`);
      await hDialog.locator('select[name="residualLikelihood"]').selectOption('1');
      await hDialog.locator('select[name="residualConsequence"]').selectOption('4');
      await hDialog.locator('textarea[name="residualNote"]').fill('Access reviews every quarter keep the remaining risk low');
      await expectOverlayReadable(hendra.page, 'Accept the residual risk');
      await button(hDialog, 'Accept residual risk').click();
      await expectToast(hendra.page, `Residual risk of ${code} accepted`);
      await expect(hDrawer).toContainText('Residual risk accepted on');

      // Known limit (handoff M2-18): the page that moved the treatment to Implemented keeps that status in memory
      // after the risk owner's acceptance in another session (registers/api.ts compares only the action text, which is
      // empty for Implemented and for Residual accepted), so Close treatment stays disabled until the page loads again.
      await go(rina, 'Registers', { fresh: true });
      await rina.page.locator('main [role="tab"]', { hasText: /^Risks$/ }).click();
      await search(rina.page, code);
      await listRow(rina.page, code).click();
      const done = ui.drawer(rina.page).locator(`[data-treatment="${treatment}"]`);
      await button(done, 'Close treatment').click();
      await expect(done).toContainText('Closed');
    });

    test('the Management System Manager imports the justifications of ten controls and edits one control on screen', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      const risk = memory.riskCode;
      await go(rina, 'Controls & requirements');
      await ui.pageAction(rina.page, 'Import').click();
      await expect(ui.title(rina.page)).toHaveText('Import');
      const main = rina.page.locator('main');
      await expect(main.locator('select').first()).toHaveValue('applicability');
      await settle(rina.page);
      await expectReadableText(rina.page, 'Import (rina)');
      const rows = ['ID,Applicable,Justification,Owner,Risks'];
      for (let n = 1; n <= 10; n += 1) {
        rows.push(`A.5.${n},Yes,"Applies: the ${risk} risk assessment needs this control for the ticketing and customer data services",${P.bagus.email},${risk}`);
      }
      await main.locator('input[type="file"]').setInputFiles({ name: 'soa-justifications.csv', mimeType: 'text/csv', buffer: Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8') });
      await button(main, 'Check file').click();
      const results = main.locator('.mx-card', { hasText: 'Check results' });
      await expect(results).toContainText('soa-justifications.csv: 10 rows');
      await expect(results).toContainText('10 OK');
      await expectReadableText(rina.page, 'the import check results');
      await button(main, 'Import 10 rows').click();
      await expectToast(rina.page, 'Importing 10 rows of controls and requirements');
      // The worker applies the rows in one transaction; the card follows the import until it is finished.
      await expect(results).toContainText('Import finished', { timeout: 120_000 });
      await expect(results).toContainText('10 changed');

      await go(rina, 'Controls & requirements');
      await chip(rina.page, 'All').click();
      await search(rina.page, 'A.5.1');
      await openRow(rina.page, 'Policies for information security');
      const panel = ui.drawer(rina.page).locator('[data-m11="entry"]');
      await expect(ui.drawer(rina.page)).toContainText(P.bagus.name);
      await button(panel, 'Edit entry').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText('Edit A.5.1');
      await dialog.locator('select[name="frequencyCode"]').selectOption('quarterly');
      await dialog.locator('textarea[name="description"]').fill('The information security policy is reviewed every quarter by the ISMS committee and approved by top management.');
      await expectOverlayReadable(rina.page, 'Edit A.5.1');
      await button(dialog, 'Save').click();
      await expectToast(rina.page, 'A.5.1 saved');
      await closeLayers(rina.page);
    });

    test('the Management System Manager registers POL-01 from its template and uploads its file for review', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      await go(rina, 'Document register');
      await ui.pageAction(rina.page, 'New document').click();
      const form = ui.drawer(rina.page);
      await expect(form).toContainText('New document');
      await form.getByLabel(/^Start from a template/).selectOption('POL-01');
      await expect(form.getByLabel(/^Document code/)).toHaveValue('POL-01');
      await expect(form.getByLabel(/^Title/)).not.toHaveValue('');
      await selectPerson(form.getByLabel(/^Owner/), P.rina.name);
      await selectPerson(form.getByLabel(/^Approver/), P.hendra.name);
      await expectOverlayReadable(rina.page, 'New document');
      await button(form, 'Register document').click();
      await expectToast(rina.page, 'POL-01 registered as a draft');
      await expect(listRow(rina.page, 'POL-01')).toContainText('Draft');
      const panel = ui.drawer(rina.page).locator('[data-docs-edit]');
      await button(panel, 'Attach first version').click();
      // The ISMS keeps its files in the Managed Vault until it moves to the SharePoint library: the author uploads the
      // policy file from the browser; MSCD stores it, versions it and records its SHA-256.
      const upload = ui.modal(rina.page);
      await expect(upload).toContainText('Managed Vault: the file is uploaded, versioned and SHA-256 checksummed by the application.');
      await expectOverlayReadable(rina.page, 'the upload of the first version');
      const chooser = rina.page.waitForEvent('filechooser');
      await button(upload, 'Upload to Managed Vault').click();
      await (await chooser).setFiles({ name: 'POL-01 Information security policy.pdf', mimeType: 'application/pdf', buffer: policyPdf() });
      const dialog = ui.modal(rina.page).last();
      await expect(dialog).toContainText('First version of POL-01');
      await expect(dialog).toContainText(/POL-01.*\.pdf/);
      await dialog.locator('textarea').fill('First issue of the information security policy for the ISMS scope');
      await expectOverlayReadable(rina.page, 'First version of POL-01');
      await button(dialog, 'Submit for review').click();
      await expectToast(rina.page, /POL-01 v[\d.]+ submitted for review/);
      await expect(listRow(rina.page, 'POL-01')).toContainText('In review');
      await closeLayers(rina.page);
    });

    test('Top Management approves POL-01, which the Management System Manager submitted', async ({ browser }) => {
      const hendra = await as(browser, 'hendra');
      await go(hendra, 'Document register', { fresh: true });
      await openRow(hendra.page, 'POL-01');
      await drawerAction(hendra.page, 'Open review').click();
      const review = ui.modal(hendra.page).last();
      await expect(review).toContainText('Review of POL-01');
      await expect(review).toContainText('First issue of the information security policy for the ISMS scope');
      await expectOverlayReadable(hendra.page, 'the review of POL-01');
      await button(review, 'Approve').click();
      await expectToast(hendra.page, /POL-01 v[\d.]+ approved/);
      await expect(listRow(hendra.page, 'POL-01')).toContainText('Approved');
      await closeLayers(hendra.page);
    });

    test('the ISMS moves to its folder in the SharePoint library: the folder is set, tested and made the default repository', async ({ browser }) => {
      // The repository settings get the folder of the system, which seals the credential again for the new settings;
      // then the system's default repository becomes the library. The approved POL-01 stays in the Managed Vault.
      const ana = await as(browser, 'ana');
      const sp = state.sharepoint;
      await go(ana, 'Storage repositories');
      const card = ana.page.locator('main div[style*="box-shadow"][style*="flex-direction: column"]').filter({ hasText: 'SharePoint Compliance' }).last();
      await card.locator('button[title="Settings"]').click();
      const settings = ui.drawer(ana.page);
      await expect(settings).toContainText('SharePoint Compliance');
      await settings.locator('[name="root-isms-id"]').fill(sp.ismsFolderId);
      await settings.locator('[name="root-isms-path"]').fill(sp.ismsPath);
      await expectOverlayReadable(ana.page, 'the repository settings');
      await button(settings, 'Save').click();
      await expect(settings).toContainText('The settings changed, so the credential was removed. Set it again, then test the connection.');
      await settings.locator('[name="credential-tenantId"]').fill(sp.tenantId);
      await settings.locator('[name="credential-clientId"]').fill(sp.clientId);
      await settings.locator('[name="credential-certificate"]').fill(sp.certificatePem);
      await settings.locator('[name="credential-privateKey"]').fill(sp.privateKeyPem);
      await button(settings, 'Save credential').click();
      await expectToast(ana.page, 'Credential saved and sealed');
      await button(settings, 'Test connection').click();
      await expect(settings.locator('[role="status"]').filter({ hasText: 'Connected to' })).toContainText('Connected to Compliance');
      await closeLayers(ana.page);

      await go(ana, 'Management systems');
      const row = ana.page.locator('main table tbody tr', { hasText: 'ISO/IEC 27001' });
      await expect(row).toContainText('Managed Vault');
      await button(row, 'Edit').click();
      const drawer = ui.drawer(ana.page);
      await expect(drawer).toContainText('Edit ISMS');
      // The form shows the system's current values before the administrator changes one, as a person sees it filled.
      await expect(drawer.locator('[name="scopeStatement"]')).toHaveValue(ISMS_SCOPE);
      await expect(drawer.locator('[name="certificationBody"]')).toHaveValue(CERTIFICATION_BODY);
      await expect(drawer.getByLabel('Teal')).toBeChecked();
      await drawer.locator('select').last().selectOption({ label: 'SharePoint Compliance' });
      await expect(drawer.locator('[name="scopeStatement"]')).toHaveValue(ISMS_SCOPE);
      await expectOverlayReadable(ana.page, 'Edit ISMS');
      await button(drawer, 'Save').click();
      await expectToast(ana.page, 'ISMS saved');
      await closeLayers(ana.page);
      await expect(row).toContainText('SharePoint Compliance');
    });

    test('the Management System Manager defines evidence on A.5.1 with a file; the owner completes the control and the manager verifies it', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      // The system moved to the SharePoint library since the app loaded: the evidence file is linked from there.
      await go(rina, 'Evidence freshness', { fresh: true });
      await ui.pageAction(rina.page, 'New evidence').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText('New evidence');
      const code = await filledValue(dialog.locator('input[name="code"]'));
      expect(code).toMatch(/^EV-\d+$/);
      await dialog.locator('input[name="title"]').fill('Approved information security policy and its communication record');
      await dialog.locator('select[name="frequencyCode"]').selectOption('quarterly');
      await dialog.locator('input[type="search"]').first().fill('A.5.1');
      await dialog.locator('[role="option"]').filter({ hasText: 'A.5.1' }).first().click();
      await expect(dialog.locator('.mx-m11-codes')).toContainText('A.5.1');
      await expectOverlayReadable(rina.page, 'New evidence');
      await button(dialog, 'Create evidence').click();
      await expect(dialog).toContainText('Attach the first file');
      await button(dialog, 'Choose file').click();
      const picker = ui.modal(rina.page);
      await expect(picker).toContainText('Compliance / ISMS');
      const files = picker.locator('button[style*="grid-template-columns: 1fr auto"]');
      await expect(files.first()).toBeVisible();
      const name = (await files.first().innerText()).split('\n')[0].trim();
      await expectOverlayReadable(rina.page, 'the evidence file picker');
      await button(picker, 'Link selected file').click();
      await expectToast(rina.page, `${code}: ${name} attached`);
      await expect(ui.modal(rina.page)).toHaveCount(0);

      // The Domain Owner of A.5.1 marks it complete; the Management System Manager, who did not complete it, verifies it.
      const bagus = await as(browser, 'bagus');
      await go(bagus, 'Controls & requirements', { fresh: true });
      await chip(bagus.page, 'All').click();
      await search(bagus.page, 'A.5.1');
      await openRow(bagus.page, 'Policies for information security');
      await drawerAction(bagus.page, 'Mark complete').click();
      await expectToast(bagus.page, 'Marked complete');
      await expect(ui.drawer(bagus.page)).toContainText('Complete, awaiting verification');
      await closeLayers(bagus.page);

      await go(rina, 'Controls & requirements', { fresh: true });
      await chip(rina.page, 'All').click();
      await search(rina.page, 'A.5.1');
      await openRow(rina.page, 'Policies for information security');
      await expect(ui.drawer(rina.page)).toContainText('Complete, awaiting verification');
      await drawerAction(rina.page, 'Verify').click();
      const confirm = ui.modal(rina.page);
      await expect(confirm).toContainText(`completed by ${P.bagus.name}`);
      await expectOverlayReadable(rina.page, 'the verification');
      await button(confirm, 'Confirm verification').click();
      await expect(ui.drawer(rina.page)).toContainText('Implemented');
      await closeLayers(rina.page);
    });

    test('the Internal Auditor plans and records an internal audit and raises a finding', async ({ browser }) => {
      const maya = await as(browser, 'maya');
      await go(maya, 'Internal audit', { fresh: true });
      await expect(maya.page.locator('main')).toContainText('No internal audit in this cycle yet');
      await ui.pageAction(maya.page, 'Plan internal audit').click();
      const dialog = ui.modal(maya.page);
      await expect(dialog).toContainText('Plan an internal audit');
      await dialog.locator('input[name="name"]').fill('Internal audit of the ISMS 2026');
      await dialog.locator('input[name="shortLabel"]').fill('IA 2026');
      await dialog.locator('input[name="scheduledAt"]').fill(INTERNAL_AUDIT);
      await dialog.locator('input[name="auditDays"]').fill('2');
      await selectPerson(dialog.locator('select[name="lead"]'), P.maya.name);
      await dialog.locator('textarea[name="scopeText"]').fill('Clauses 4 to 10 and Annex A theme 5, Jakarta head office');
      await expectOverlayReadable(maya.page, 'Plan an internal audit');
      await button(dialog, 'Plan internal audit').click();
      await expectToast(maya.page, 'Internal audit IA 2026 planned');
      const drawer = ui.drawer(maya.page);
      await expect(drawer).toContainText('IA 2026: Internal audit of the ISMS 2026');
      await expect(drawer).toContainText(P.maya.name);
      // Known limit (M2-14 backlog, handoff M2-18): no pack has activity templates for internal audits and the drawer has
      // no action to add an activity, so the audit keeps the empty activity list the screen explains.
      await button(drawer, 'Generate from templates').click();
      await expectToast(maya.page, 'The framework pack of this system has no activity templates for internal audits yet, so no activity was created.');
      await expect(drawer).toContainText('No activities yet.');
      await expectOverlayReadable(maya.page, 'the internal audit');
      await button(drawer, 'Record outcome summary').click();
      const outcome = ui.modal(maya.page);
      await outcome.locator('textarea[name="outcomeSummary"]').fill('The scope was covered. One minor nonconformity: the policy communication is not recorded.');
      await expectOverlayReadable(maya.page, 'Record outcome summary');
      await button(outcome, 'Save').click();
      await expectToast(maya.page, 'Outcome summary of IA 2026 saved');
      await expect(drawer).toContainText('The scope was covered. One minor nonconformity');

      await button(drawer, 'Raise finding').click();
      const raise = ui.modal(maya.page);
      await expect(raise.locator('select[name="source"]')).toHaveValue('internal_audit');
      const code = await filledValue(raise.locator('input[name="code"]'));
      memory.findingCode = code;
      remember();
      await raise.locator('textarea[name="title"]').fill('The communication of the information security policy is not recorded');
      await raise.locator('select[name="classification"]').selectOption('minor');
      await raise.locator('select[name="targetCode"]').selectOption('A.5.1');
      await selectPerson(raise.locator('select').filter({ has: maya.page.locator('option', { hasText: P.bagus.name }) }).first(), P.bagus.name);
      await expectOverlayReadable(maya.page, 'Raise finding');
      await button(raise, 'Raise finding').click();
      await expectToast(maya.page, `Finding ${code} raised`);
      await expect(drawer).toContainText(code);
      await closeLayers(maya.page);
    });

    test('the Management System Manager attaches the internal audit report from the library', async ({ browser }) => {
      // The report is a registered record of the system; the Internal Auditor does not register documents.
      const rina = await as(browser, 'rina');
      await go(rina, 'Internal audit', { fresh: true });
      await rina.page.locator('main tr[data-hov]', { hasText: 'IA 2026' }).click();
      await button(ui.drawer(rina.page), 'Attach report').click();
      const attach = ui.modal(rina.page);
      await attach.locator('label', { hasText: 'A new record from a file' }).click();
      await expect(attach.locator('input[name="docCode"]')).toHaveValue('REC-IA-2026');
      await expectOverlayReadable(rina.page, 'Attach the audit report');
      await button(attach, 'Choose file and attach').click();
      const picker = ui.modal(rina.page);
      await expect(picker).toContainText('Compliance / ISMS / Documents');
      await picker.locator('button', { hasText: 'IMS-02.docx' }).click();
      await button(picker, 'Link selected file').click();
      await expectToast(rina.page, 'Report REC-IA-2026 attached to IA 2026');
      await expect(rina.page.locator('main tr[data-hov]', { hasText: 'IA 2026' })).toContainText('REC-IA-2026');
      await closeLayers(rina.page);
    });

    test('the Management System Manager opens a corrective action, which its owner implements', async ({ browser }) => {
      const code = memory.findingCode;
      const rina = await as(browser, 'rina');
      await go(rina, 'Findings and actions', { fresh: true });
      await rina.page.locator('main tr[data-hov]', { hasText: code }).click();
      const drawer = ui.drawer(rina.page);
      await button(drawer, 'Create corrective action').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText('Create a corrective action');
      const action = await filledValue(dialog.locator('input[name="code"]'));
      memory.actionCode = action;
      remember();
      await dialog.locator('input[name="title"]').fill('Record the communication of every approved policy');
      await selectPerson(dialog.locator('select').filter({ has: rina.page.locator('option', { hasText: P.bagus.name }) }).first(), P.bagus.name);
      await expectOverlayReadable(rina.page, 'Create a corrective action');
      await button(dialog, 'Create corrective action').click();
      await expectToast(rina.page, `Corrective action ${action} created`);
      await closeLayers(rina.page);

      const bagus = await as(browser, 'bagus');
      await go(bagus, 'Findings and actions', { fresh: true });
      await bagus.page.locator('main [role="tab"]', { hasText: 'Corrective actions' }).click();
      await bagus.page.locator('main tr[data-hov]', { hasText: action }).click();
      const bDrawer = ui.drawer(bagus.page);
      for (const [step, text] of [
        ['Correction', 'The policy was sent to every employee again with a read receipt'],
        ['Root cause analysis', 'The policy procedure had no step to record its communication'],
        ['Systemic check', 'Every approved policy of the ISMS was checked for a communication record'],
        ['Action', 'The document control procedure now records the communication of each approved version'],
      ]) {
        await bDrawer.locator('textarea[name="stepText"]').fill(text);
        await button(bDrawer, 'Complete step').click();
        await expectToast(bagus.page, `${step} recorded for ${action}`);
      }
      await expect(button(bDrawer, 'Record effectiveness check')).toBeDisabled();
      // The owner implemented it; a Management System Manager, a Programme Owner or an Internal Auditor checks it.
      await expect(bDrawer).toContainText('Only a Management System Manager, a Programme Owner or an Internal Auditor checks effectiveness.');
      await expectOverlayReadable(bagus.page, 'the corrective action');
      await closeLayers(bagus.page);
    });

    test('five weeks later: the effectiveness is checked by a third person and the finding closes', async ({ browser }) => {
      // The check is made on another day than the implementation (BR-08); by now the Stage 2 audit has taken place.
      await travelTo(LATER);
      const action = memory.actionCode;
      const code = memory.findingCode;
      const rina = await as(browser, 'rina');
      await go(rina, 'Findings and actions');
      await rina.page.locator('main [role="tab"]', { hasText: 'Corrective actions' }).click();
      await rina.page.locator('main tr[data-hov]', { hasText: action }).click();
      const drawer = ui.drawer(rina.page);
      await button(drawer, 'Record effectiveness check').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText(`Effectiveness check of ${action}`);
      await dialog.getByLabel('Effective: close the action').check();
      await dialog.locator('textarea').last().fill('Communication records exist for every policy approved since the action');
      await expectOverlayReadable(rina.page, 'the effectiveness check');
      await button(dialog, 'Record effectiveness check').click();
      await expectToast(rina.page, `Effectiveness check of ${action} recorded`);
      await expect(drawer).toContainText('This corrective action is finished.');
      await closeLayers(rina.page);

      await rina.page.locator('main [role="tab"]', { hasText: 'Findings' }).first().click();
      await rina.page.locator('main tr[data-hov]', { hasText: code }).click();
      await button(ui.drawer(rina.page), 'Close finding').click();
      const close = ui.modal(rina.page);
      await expect(close).toContainText(`Close finding ${code}`);
      await expectOverlayReadable(rina.page, 'Close finding');
      await button(close, 'Close finding').click();
      await expectToast(rina.page, `Finding ${code} closed`);
      await closeLayers(rina.page);
    });

    test('the management review is held with every input and closed with its decisions', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      await go(rina, 'Management review');
      await expect(rina.page.locator('main')).toContainText('No management review yet');
      await ui.pageAction(rina.page, 'Plan review').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText('Plan a management review');
      const code = await filledValue(dialog.locator('input[name="code"]'));
      await dialog.locator('input[name="plannedAt"]').fill(LATER);
      await selectPerson(dialog.locator('select').first(), P.hendra.name);
      await expectOverlayReadable(rina.page, 'Plan a management review');
      await button(dialog, 'Plan review').click();
      await expectToast(rina.page, `Management review ${code} planned`);
      const drawer = ui.drawer(rina.page);
      // The review gets one empty input per mandatory input of the standard; the row counts them once it is listed.
      const row = rina.page.locator('main tr[data-hov]', { hasText: code });
      await expect(row).toContainText(/0 of \d+ complete/);
      const total = Number((await row.innerText()).match(/0 of (\d+) complete/)[1]);
      expect(total).toBeGreaterThan(0);
      const inputs = drawer.locator('[data-input]');
      await expect(inputs).toHaveCount(total);
      for (let i = 0; i < total; i += 1) {
        await button(inputs.nth(i), 'Record input').click();
        await ui.modal(rina.page).locator('textarea[name="content"]').fill(`Input ${i + 1} of ${total}, prepared by the ISMS Manager for the review`);
        await button(ui.modal(rina.page), 'Save').click();
        await expect(inputs.nth(i)).toContainText('Complete');
      }
      await expect(drawer).toContainText(`${total} of ${total} complete`);
      await closeLayers(rina.page);

      // Top management chairs the review: it marks it held and closes it with the decisions (BR-13, BR-14).
      const hendra = await as(browser, 'hendra');
      await go(hendra, 'Management review', { fresh: true });
      await hendra.page.locator('main tr[data-hov]', { hasText: code }).click();
      const hDrawer = ui.drawer(hendra.page);
      await button(hDrawer, 'Mark held').click();
      await expectOverlayReadable(hendra.page, 'Mark held');
      await button(ui.modal(hendra.page), 'Mark held').click();
      await expectToast(hendra.page, `Management review ${code} marked held`);
      await button(hDrawer, 'Close review').click();
      const close = ui.modal(hendra.page);
      await close.locator('textarea[name="decisionsText"]').fill('Budget approved for the access review tool; the policy communication record becomes a yearly objective');
      await expectOverlayReadable(hendra.page, 'Close review');
      await button(close, 'Close review').click();
      await expectToast(hendra.page, `Management review ${code} closed`);
      await expect(hendra.page.locator('main tr[data-hov]', { hasText: code })).toContainText('Closed');
      await closeLayers(hendra.page);
    });

    test('the Stage 2 outcome and the certificate are recorded; the system is certified and readiness moved', async ({ browser }) => {
      const rina = await as(browser, 'rina');
      await go(rina, 'Certification timeline');
      await rina.page.locator(`main button[title="Stage 2, ${dmy(STAGE2)}"]`).click();
      const panel = rina.page.locator('main [data-tl-panel]');
      await button(panel, 'Record result').click();
      const dialog = ui.modal(rina.page);
      await expect(dialog).toContainText('Record audit result');
      await dialog.locator('select[name="outcome"]').selectOption('recommended');
      await dialog.locator('textarea[name="summary"]').fill('Recommended for certification, no nonconformity');
      await expectOverlayReadable(rina.page, 'Record audit result');
      await button(dialog, 'Save').click();
      await expectToast(rina.page, 'Result of Stage 2 recorded');
      await expect(panel).toContainText('Result: Recommended');

      await ui.pageAction(rina.page, 'Record certificate').click();
      const cert = ui.modal(rina.page);
      await expect(cert).toContainText(`Based on Stage 2 of ${dmy(STAGE2)}: Recommended.`);
      await cert.locator('input[name="certificateNo"]').fill(CERTIFICATE_NO);
      const expires = await cert.locator('input[name="expiresAt"]').inputValue();
      expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await expectOverlayReadable(rina.page, 'Record certificate');
      await button(cert, 'Record certificate').click();
      await expectToast(rina.page, `Certificate ${CERTIFICATE_NO} recorded. The system is certified until ${dmy(expires)}.`);
      const cycle = panel.locator('[data-tl-cycle]');
      await expect(cycle).toHaveAttribute('data-tl-cycle', 'certified');
      await expect(cycle).toContainText(CERTIFICATE_NO);
      await expect(cycle.locator('[data-tl-expires]')).toContainText(dmy(expires));

      // The system shows as certified, for the administrator in Management systems and for the manager on the timeline
      // after the app loads again.
      const ana = await as(browser, 'ana');
      await go(ana, 'Management systems', { fresh: true });
      await expect(ana.page.locator('main table tbody tr', { hasText: 'ISO/IEC 27001' })).toContainText('Certified');
      await go(rina, 'Certification timeline', { fresh: true });
      await expect(rina.page.locator('main [data-tl-cycle]')).toHaveAttribute('data-tl-cycle', 'certified');
      await expect(rina.page.locator('main [data-tl-expires]')).toContainText(dmy(expires));

      // The readiness of the clauses moved above 0 (D.6): the worker recomputes it after each change.
      await go(rina, 'Overview');
      await expect(rina.page.locator('main')).toContainText('Internal progress score');
      // The level of each clause row (4 to 10) is its last cell: a number from 0.0 to 4.0, or - when not computed.
      const levels = () => rina.page.locator('main button').evaluateAll((rows) => rows
        .map((row) => [row.firstElementChild?.textContent?.trim() ?? '', row.lastElementChild?.textContent?.trim() ?? ''])
        .filter(([head, level]) => /^(4|5|6|7|8|9|10)\D/.test(head) && /^(\d\.\d|-)$/.test(level))
        .map(([, level]) => Number.parseFloat(level)));
      await expect.poll(async () => (await levels()).length).toBe(7);
      await expect.poll(async () => (await levels()).filter((n) => n > 0).length, { timeout: 120_000 }).toBeGreaterThan(0);
    });
  }
});
