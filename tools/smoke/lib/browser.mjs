// The browser side of the SaaS runs (Milestone 2 plan K.6, M2-S13; MILESTONE-3 M3-11): one browser session per person,
// sign-in with password and authenticator, the readability check of every screen a person sees for the first time, and
// the watch that fails a step on any page error, console error, 5xx answer or 4xx answer the step does not expect.
// tests/saas.spec.mjs and tests/data-lifecycle.spec.mjs share it; each spec keeps its own people and steps.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { linkFor } from './mailpit.mjs';
import { expectOverlayReadable, expectReadableText } from './readable.mjs';
import { uatShot } from './uat-shots.mjs';
import { codeOf, secondsLeftInStep } from './totp.mjs';

// ---- locators of the app (the structure the web E2E suites use, apps/web/e2e/helpers.js) ----
export const ui = {
  title: (page) => page.locator('main h1'),
  toast: (page) => page.locator('div[style*="z-index: 60"]'),
  drawer: (page) => page.locator('div[style*="z-index: 41"]'),
  modal: (page) => page.locator('div[style*="z-index: 51"]'),
  nav: (page, label) => page.locator(`aside nav button[title="${label}"]`),
  msSwitch: (page) => page.locator('header button[title="Switch management system"]'),
  pageAction: (page, label) => page.locator(`main button[title="${label}"]`).first(),
};
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const button = (scope, name) => scope.locator('button', { hasText: new RegExp(`^\\s*${esc(name)}\\s*$`) });

/** The cookies MSCD may set (docs/saas/legal-inputs.md, "Cookies and browser storage"; GL-56). */
export const ESSENTIAL_COOKIES = new Set(['__Host-mscd_session', 'mscd_auth_tx', 'mscd_saml_tx', 'mscd_guest_tx', 'mscd_repo_tx']);

/**
 * One run in the browser against a SaaS test stack.
 *
 * `state` is the run state of run-saas.mjs; `personOf(key)` names the person of a key (`{ key, name, email, ... }`);
 * `password` is the password every local account of the run chooses. With `memoryFile` the authenticator secrets the
 * people enrolled (their phones) are kept in that file, so a later Playwright run against a stack left by --keep can
 * sign them in again.
 */
export function createBrowserRun({ state, personOf, password, memoryFile = null }) {
  const memory = memoryFile && existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')) : { secrets: {}, found: {} };
  const remember = () => {
    if (memoryFile) writeFileSync(memoryFile, JSON.stringify(memory, null, 2), { mode: 0o600 });
  };
  const secrets = new Map(Object.entries(memory.secrets ?? {}));
  const lastStep = new Map();
  const visited = new Set();
  const sessions = new Map();
  const problems = [];

  /**
   * Answers from 400 to 499 that belong to the run: `status`, `method`, `path` (matched against the path and query)
   * and `who` (a person key or a list of them; absent for anyone). Any other 4xx answer, and every 5xx answer, fails
   * the run.
   */
  const expectedAlways = [
    // The app asks for the session first; without one the answer is 401 and the sign-in page opens (build plan H.7).
    { status: 401, method: 'GET', path: /^\/api\/v1\/me$/ },
  ];
  /** The answers the current step expects (`expecting`), and answers a step adds for the rest of the run. */
  const expectedNow = [];
  /** Every answer of 400 or more a page received (`who status url`), expected or not, for the browser's console lines. */
  const answered = new Set();
  /** The browser's "Failed to load resource" lines, checked after each step against the answers the pages received. */
  const failedLoads = [];
  /** Console errors a step expects: `{ who, pattern }`. */
  const expectedConsole = [];

  function isExpected(who, status, method, url) {
    const path = url.pathname + url.search;
    return [...expectedAlways, ...expectedNow].some((a) => a.status === status && a.method === method && a.path.test(path) && (!a.who || [a.who].flat().includes(who)));
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
      if (expectedConsole.some((c) => (!c.who || [c.who].flat().includes(who)) && c.pattern.test(text))) return;
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

  /** Checks an open dialog or drawer the first time the run sees it. */
  async function firstOverlay(s, label) {
    const key = `overlay:${label}`;
    if (visited.has(key)) return;
    await expectOverlayReadable(s.page, label);
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
    memory.secrets = Object.fromEntries(secrets);
    remember();
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
    const secret = secrets.get(s.key);
    expect(secret, `the authenticator secret of ${s.key}`).toBeTruthy();
    return codeOf(secret);
  }

  /** Email and password on the sign-in page (already open), then the second factor. */
  async function passwordAndCode(s) {
    const { page } = s;
    await page.locator('#au-email').fill(s.who.email);
    await page.locator('#au-password').fill(password);
    await page.locator('.au-form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await expect(page.locator('#au-code')).toBeVisible();
    await firstVisit(s, 'the second-factor page');
    await page.locator('#au-code').fill(await totpCode(s));
  }

  /**
   * Signs a person in with password and authenticator code, and waits for the app: a screen, or the full-page message
   * of a member who holds no role yet (`role="alert"`, with Sign out). The loading message (`role="status"`) does not
   * count: a navigation while the app still loads its data would cut that load off.
   */
  async function signIn(s) {
    const { page } = s;
    await page.goto('/');
    await expect(page.locator('main h1, #au-email, div.mscd[role="alert"]').first()).toBeVisible();
    if (!/\/login/.test(page.url())) return;
    await firstVisit(s, 'the sign-in page');
    await passwordAndCode(s);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    await expect(page.locator('main h1, div.mscd[role="alert"]').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  /** The session of a person, signed in when this Playwright run has not signed them in yet. */
  async function as(browser, key) {
    const s = await person(browser, key);
    if (s.page.url() === 'about:blank') await signIn(s);
    return s;
  }

  /** Accepts an emailed invitation with a new password and enrols the authenticator. */
  async function acceptInvitation(s) {
    const { page } = s;
    await page.goto(await linkFor(s.who.email));
    await expect(page.locator('#au-new-password')).toBeVisible();
    await firstVisit(s, 'the invitation page');
    await page.locator('#au-new-password').fill(password);
    await page.locator('#au-repeat-password').fill(password);
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
    await uatShot(page, text, 'toast');
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

  /** The `docker compose` arguments of the stack. */
  const compose = (...args) => ['compose', '--project-name', state.project, ...state.files.flatMap((f) => ['-f', f]), '--env-file', state.envFile, ...args];

  /** Runs a command in a running service of the stack (`docker compose exec`); returns its output. */
  function composeExec(service, args, { timeout = 60_000 } = {}) {
    const r = spawnSync('docker', compose('exec', '-T', service, ...args), { encoding: 'utf8', timeout });
    expect(r.status, `docker compose exec ${service}: ${r.stderr}`).toBe(0);
    return r.stdout;
  }

  /** Runs a command in a new container of a service (`docker compose run --rm`); returns its status and output. */
  function composeRun(service, args, { volumes = [], profile, timeout = 120_000 } = {}) {
    const r = spawnSync('docker', [
      ...compose(...(profile ? ['--profile', profile] : []), 'run', '--rm', '--no-deps', '-T', ...volumes.flatMap((v) => ['-v', v]), service, ...args),
    ], { encoding: 'utf8', timeout });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** Publishes a TXT record in the mock DNS, as the customer's IT team adds it to their domain. */
  function publishTxt(name, value) {
    const script = `const r = await fetch('http://127.0.0.1:4310/_admin/dns/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ name, values: [value] })}) }); if (!r.ok) { process.stderr.write(String(r.status) + ' ' + await r.text()); process.exit(1); }`;
    composeExec('mock-providers', ['node', '--input-type=module', '-e', script]);
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

  /** The values a step found that later steps need (kept in the memory file with the secrets). */
  const found = new Proxy(memory.found ?? (memory.found = {}), {
    set(target, key, value) {
      target[key] = value;
      remember();
      return true;
    },
  });

  /** After each step: no page error, console error, 5xx answer or unexpected 4xx answer happened. */
  function expectNoProblems() {
    checkFailedLoads();
    expect(problems.splice(0), 'page errors, console errors, 5xx answers and unexpected 4xx answers during the step').toEqual([]);
  }

  async function closeAll() {
    for (const s of sessions.values()) await s.context.close().catch(() => {});
  }

  return {
    state, secrets, visited, sessions, problems, expectedNow, expectedConsole, found,
    expecting, checkFailedLoads, watch, person, firstVisit, firstOverlay, freshStep, enrol, totpCode, passwordAndCode, signIn, as,
    acceptInvitation, reloadApp, settle, closeLayers, switchMs, go, expectToast, expectEssentialCookies, composeExec, composeRun,
    publishTxt, operatorOrganisations, orgRow, manage, moveStatus, expectNoProblems, closeAll,
  };
}
