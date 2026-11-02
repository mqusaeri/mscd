// Data lifecycle run (MILESTONE-3 M3-11): the life of a customer organisation's data on one SaaS stack of release
// images, from its first policy to its verified deletion, every step on screen with one browser session per person.
// run-saas.mjs --lifecycle starts the stack with the lifecycle periods of Milestone 3 D.3 at 0 days (MSCD_SAAS_TEST=1 on
// the api and the worker, a test stack only), runs saas-ops.sh create-operator and passes the state of the run
// (SAAS_RUN_STATE). The run fails on any page error, console error, 5xx answer or 4xx answer that its step does not
// expect, and checks the readability of every screen and dialog it opens (WCAG AA contrast, no text under 12px).
//
//   1. The operator sets a password and an authenticator, creates Alpha and Beta; their first administrators join.
//   2. Alpha's team joins; the ISMS gets its two Management System Managers (four eyes), two Domain Owners and two
//      evidence items. Beta gets its QMS, and Eka of Alpha joins Beta as well.
//   3. Read confirmation: POL-01 needs confirmation; Dimas approves its first version, Eka and Fajar open and confirm it,
//      and Ayu closes the request into the evidence item of A.5.1.
//   4. Retention: a lapsed competence record; Ayu sets 1 month for its record type; the daily review opens it; Ayu
//      proposes disposal and Dimas, the second person, approves it; the disposal register shows it.
//   5. Access review: Ayu starts it, the people decide on each other's access, the revocation of the leaver's role is
//      applied, the ISMS is signed off and the completed review is filed as evidence of A.5.18.
//   6. Eka downloads "My data"; an access request of Eka is answered with a copy of her data after the system check;
//      the leaver Fajar is erased after the system check.
//   7. The operator moves Alpha to offboarding; Ayu downloads every part of the final export and the manifest, and the
//      run checks each SHA-256 against the manifest.
//   8. The operator runs org.lifecycle: Alpha is archived; the deletion date is set to now; org.lifecycle runs again and
//      the purge completes; the signed certificate downloads, reaches the Tenant Admins by email and passes
//      "mscd-server tenant verify-certificate" in the stack's cli container.
//   9. Alpha's sign-in shows no organisation; Beta and Eka, a person in both, keep working.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { button, createBrowserRun, esc, ui } from '../lib/browser.mjs';
import { ALPHA, BETA, PASSWORD, PEOPLE } from '../lib/lifecycle-data.mjs';
import { linkFor, waitForMail } from '../lib/mailpit.mjs';
import { PANEL_SCOPE, expectOverlayReadable, expectReadableText } from '../lib/readable.mjs';

if (!process.env.SAAS_RUN_STATE) throw new Error('SAAS_RUN_STATE is not set: run it with npm run lifecycle -w @mscd/smoke (run-saas.mjs starts the stack first)');
const state = JSON.parse(readFileSync(process.env.SAAS_RUN_STATE, 'utf8'));
if (!state.lifecycle) throw new Error('the stack of this run state was started without --lifecycle: its lifecycle periods are not 0 days');

const run = createBrowserRun({
  state,
  password: PASSWORD,
  memoryFile: path.join(state.stateDir, 'lifecycle-memory.json'),
  personOf: (key) => {
    if (key === 'stranger') return { key, name: 'A stranger' };
    const p = key === 'operator' ? state.operator : PEOPLE[key];
    if (!p) throw new Error(`unknown person ${key}`);
    return p;
  },
});
const { found } = run;
const ISMS = ALPHA.system;
const QMS = BETA.system;
/** The people of Alpha: their sessions end when Alpha is archived, and their accounts go with the purge. */
const ALPHA_PEOPLE = [ALPHA.admin.key, ALPHA.second.key, ALPHA.member.key, ALPHA.leaver.key];

// ---- dates ----
/** The day of an instant in a time zone, and today there, as YYYY-MM-DD. */
const todayInAt = (timeZone, at) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const todayIn = (timeZone) => todayInAt(timeZone, new Date());
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
/** The time zone of the run's browsers (lifecycle.config.mjs): the screens show the local day of an instant in it. */
const browserTimeZone = () => test.info().project.use.timezoneId ?? 'UTC';
/** The local day (YYYY-MM-DD) of an instant of the api, as the screens work it out in the browser. */
const browserDay = (instant) => todayInAt(browserTimeZone(), new Date(instant));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * How an English screen shows a day: '1 Nov 2026' with the organisation's date helpers (apps/web/src/data/dates.js),
 * the plain YYYY-MM-DD where a screen has none (the operator console of a person without an organisation).
 */
const shownDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new RegExp(`(?:${d} ${MONTHS[m - 1]} ${y}|${esc(day)})`);
};

// ---- small helpers ----
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const list = (page) => page.locator('main input[placeholder^="Search"]').locator('xpath=../..');
const listRow = (page, text) => list(page).locator('tbody > tr[style*="cursor: pointer"]').filter({ hasText: text }).first();
const drawerAction = (page, label) => ui.drawer(page).locator(`button[title="${label}"]`);
const tab = (page, name) => page.locator('main [role="tab"]', { hasText: new RegExp(`^${esc(name)}$`) });
const card = (page, title) => page.locator('main section.mx-card').filter({ has: page.locator('h2', { hasText: new RegExp(title) }) });
const rows = (scope) => scope.locator('table tbody tr');
const personRows = (scope, name) => rows(scope).filter({ has: scope.page().locator('td strong[data-person]', { hasText: new RegExp(`^${esc(name)}$`) }) });

async function openRow(page, text) {
  await listRow(page, text).click();
  await expect(ui.drawer(page)).toBeVisible();
  await expect(ui.drawer(page)).toContainText(text);
}

async function selectPerson(select, name) {
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  expect(value, `an option for ${name}`).toBeTruthy();
  await select.selectOption(value);
}

async function openTab(page, name) {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await run.settle(page);
}

/** Starts a download with `click` and returns the file's name and bytes. */
async function downloaded(page, click, { timeout = 60_000 } = {}) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), click()]);
  const file = await download.path();
  return { name: download.suggestedFilename(), url: download.url(), bytes: readFileSync(file) };
}

/** Polls `read` until `ok(value)` holds; returns the value. */
async function until(read, ok, { timeoutMs = 120_000, intervalMs = 2000, what = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) throw new Error(`${what} did not hold within ${timeoutMs} ms; last value: ${JSON.stringify(last)?.slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A JSON read of the api in a person's session (not a page request, so the watch of the page does not see it). */
async function apiJson(s, url) {
  const res = await s.page.request.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  return res.json();
}

/** A one-page PDF of the information security policy, the file of the first version of POL-01. */
function policyPdf() {
  const text = `BT /F1 14 Tf 72 760 Td (POL-01 Information security policy, ${ALPHA.name}) Tj ET`;
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

/**
 * Starts the daily job `retention.review` of an organisation for its local date, as `scheduler.tick` does at 03:15
 * local time (Milestone 3 J.3): the job is sent to the queue from the worker container with the server's own queue
 * driver and configuration. A test stack only; the job itself is the one the schedule runs.
 */
function startRetentionReview(orgId, localDate) {
  const script = [
    "const { MscdConfig } = require('./apps/server/dist/config/mscd-config.js');",
    "const { PgBossJobQueue } = require('./apps/server/dist/modules/jobs/pgboss-job-queue.js');",
    '(async () => {',
    "  const config = MscdConfig.load({ runMode: 'worker' });",
    "  const queue = new PgBossJobQueue({ connectionString: config.databaseUrl('app'), applicationName: 'mscd-lifecycle-run' });",
    `  const id = await queue.send('retention.review', { orgId: ${JSON.stringify(orgId)}, payload: { localDate: ${JSON.stringify(localDate)} } }, { singletonKey: ${JSON.stringify(`rt:${orgId}:${localDate}`)}, retryLimit: 0 });`,
    '  await queue.stop();',
    "  process.stdout.write(String(id ?? 'already queued'));",
    '})().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });',
  ].join('\n');
  return run.composeExec('worker', ['node', '-e', script]).trim();
}

/**
 * Waits until the next run of the hourly `org.lifecycle` schedule (minute 20 UTC) is at least `minutes` away, so the
 * schedule neither archives Alpha before its final export is downloaded nor purges it before the date is set: the
 * operator runs the job from the console in this run.
 */
async function awayFromLifecycleSchedule(page, minutes) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(20, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  const left = next.getTime() - now.getTime();
  if (left < minutes * 60_000) {
    // Past the scheduled run, plus the time it takes. The wait does not count against the step's own time.
    const wait = left + 3 * 60_000;
    test.info().setTimeout(test.info().timeout + wait);
    process.stdout.write(`lifecycle: waiting ${Math.round(wait / 1000)} s for the scheduled org.lifecycle run at minute 20 to pass\n`);
    await page.waitForTimeout(wait);
  }
}

/** Runs an allow-listed job from the Jobs tab of the operator console. */
async function runJob(op, name) {
  const { page } = op;
  await run.closeLayers(page);
  await page.locator('main [role="tab"]', { hasText: 'Jobs' }).click();
  await run.settle(page);
  await run.firstVisit(op, 'the jobs of the operator console');
  await page.locator('main select').selectOption(name);
  await button(page.locator('main'), 'Run job').click();
  await run.expectToast(page, `Job ${name} queued as`);
}

/** The organisation as the operator's api sees it. */
const opsOrg = (op, org) => apiJson(op, `/api/v1/ops/organizations/${org.slug}`);

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  run.expectNoProblems();
});

test.afterAll(async () => {
  await run.closeAll();
});

test.describe('The data lifecycle of a customer organisation', () => {
  test('the platform operator sets a password from the emailed link and enrols an authenticator', async ({ browser }) => {
    const op = await run.person(browser, 'operator');
    const { page } = op;
    await page.goto(await linkFor(state.operator.email, 'reset'));
    await expect(page.locator('#au-new-password')).toBeVisible();
    await run.firstVisit(op, 'the set-password page');
    await page.locator('#au-new-password').fill(PASSWORD);
    await page.locator('#au-repeat-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.locator('#au-email')).toBeVisible();
    await page.locator('#au-email').fill(state.operator.email);
    await page.locator('#au-password').fill(PASSWORD);
    await page.locator('.au-form button[type="submit"]').click();
    await run.enrol(op);
    await expect(ui.title(page)).toHaveText('Operator console');
    await run.settle(page);
    await run.firstVisit(op, 'Operator console');
  });

  test('the operator creates Alpha and Beta; their first administrators accept the invitations', async ({ browser }) => {
    const op = await run.as(browser, 'operator');
    const { page } = op;
    for (const org of [ALPHA, BETA]) {
      await run.operatorOrganisations(op);
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
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ops/organizations' && r.request().method() === 'POST');
      await button(dialog, 'Create').click();
      const created = await (await answer).json();
      expect(created.data?.slug).toBe(org.slug);
      found[`${org.key}Id`] = created.data.id;
      await expect(dialog).toContainText(`The invitation was emailed to ${org.admin.email}.`);
      await button(dialog, 'Close').click();
      await expect(run.orgRow(page, org)).toContainText('Active');
    }
    for (const org of [ALPHA, BETA]) {
      const admin = await run.person(browser, org.admin.key);
      await run.acceptInvitation(admin);
      await expect(ui.title(admin.page)).toHaveText('Getting started');
      await run.settle(admin.page);
      await run.firstVisit(admin, 'Getting started');
    }
  });

  test('alpha: the first administrator invites a second administrator and two members, who join', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    await run.go(ayu, 'People and roles');
    const dialog = ui.modal(ayu.page);
    for (const p of [ALPHA.second, ALPHA.member, ALPHA.leaver]) {
      await ui.pageAction(ayu.page, 'Invite person').click();
      await expect(dialog).toContainText('Invite a person');
      await dialog.locator('[name="email"]').fill(p.email);
      await dialog.locator('[name="displayName"]').fill(p.name);
      await dialog.locator('[name="jobTitle"]').fill(p.jobTitle);
      if (p === ALPHA.second) await dialog.getByLabel('Tenant Admin').check();
      await button(dialog, 'Send invitation').click();
      await run.expectToast(ayu.page, `Invitation sent to ${p.email}`);
      await expect(dialog).toHaveCount(0);
      await expect(ayu.page.locator('main table tbody tr', { hasText: p.email })).toContainText('Invited');
    }
    const dimas = await run.person(browser, ALPHA.second.key);
    await run.acceptInvitation(dimas);
    await expect(ui.title(dimas.page)).toHaveText('Getting started');
    // The members hold no role yet: the app says so and asks them to ask the Tenant Admin.
    for (const p of [ALPHA.member, ALPHA.leaver]) {
      const s = await run.person(browser, p.key);
      await run.acceptInvitation(s);
      await expect(s.page.locator(PANEL_SCOPE.replace(' *', ''))).toContainText('You hold no role in a management system of this organisation yet.');
      await run.firstVisit(s, 'the message for a member without a role', PANEL_SCOPE);
    }
  });

  test('alpha: the ISMS gets two Management System Managers with four eyes, two Domain Owners and two evidence items', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    const dimas = await run.as(browser, ALPHA.second.key);
    await run.go(ayu, 'Management systems');
    await ui.pageAction(ayu.page, 'New management system').click();
    const drawer = ui.drawer(ayu.page);
    const field = (name) => drawer.locator(`[name="${name}"]`);
    await field('code').fill(ISMS.code);
    await expect(field('slug')).toHaveValue(ISMS.slug);
    await field('name').fill(ISMS.name);
    await drawer.locator('select').first().selectOption(ISMS.edition);
    await expect(drawer).toContainText('Installed');
    await field('scopeStatement').fill(ISMS.scope);
    await drawer.getByLabel(ISMS.colour).check();
    await drawer.locator('select').last().selectOption({ label: 'Managed Vault' });
    await button(drawer, 'Save').click();
    await run.expectToast(ayu.page, new RegExp(`${ISMS.code} created`));

    /** A role grant in the person drawer of People and roles. */
    const grant = async (s, p, role, { primary = false, waits = false } = {}) => {
      const { page } = s;
      await run.go(s, 'People and roles');
      await page.locator('main table tbody tr', { hasText: p.email }).click();
      const personDrawer = ui.drawer(page);
      await expect(personDrawer).toContainText(p.name);
      await button(personDrawer, 'Grant role').click();
      const dialog = ui.modal(page);
      await dialog.locator('[name="ms"]').selectOption(ISMS.slug);
      await dialog.locator('[name="role"]').selectOption({ label: role });
      if (primary) await dialog.locator('[name="isPrimary"]').check();
      await run.firstOverlay(s, 'Grant role');
      await button(dialog, 'Grant role').click();
      await run.expectToast(page, waits ? 'Role grant waiting for approval' : 'Role granted');
      await run.closeLayers(page);
    };
    /** The second Tenant Admin approves a grant to an administrator (D2-12). */
    const approve = async (s, p) => {
      await run.reloadApp(s);
      await run.go(s, 'Pending approvals');
      const waiting = s.page.locator('main [data-approvals="grants"] tbody tr', { hasText: p.name });
      await button(waiting, 'Approve').click();
      await run.expectToast(s.page, `Management System Manager in ${ISMS.code} for ${p.name} approved`);
    };
    // A grant to an administrator, also to oneself, waits for the other Tenant Admin.
    await grant(ayu, ALPHA.admin, 'Management System Manager', { primary: true, waits: true });
    await approve(dimas, ALPHA.admin);
    await grant(dimas, ALPHA.second, 'Management System Manager', { waits: true });
    await approve(ayu, ALPHA.second);
    await grant(ayu, ALPHA.member, 'Domain Owner');
    await grant(ayu, ALPHA.leaver, 'Domain Owner');

    await run.reloadApp(ayu);
    await run.go(ayu, 'Management systems');
    const row = ayu.page.locator('main table tbody tr', { hasText: ISMS.framework });
    await expect(row).toContainText(ALPHA.admin.name);
    await button(row, 'Start implementation').click();
    await button(ui.modal(ayu.page), 'Start implementation').click();
    await run.expectToast(ayu.page, `${ISMS.code} is implementing`);

    // Two evidence items: the policy record of A.5.1 and the access rights record of A.5.18.
    await run.go(ayu, 'Evidence freshness', { ms: ISMS.code });
    for (const [key, code, target, title] of [['policyEvidence', 'EV-0001', 'A.5.1', 'Policy communication and read confirmations'], ['accessEvidence', 'EV-0002', 'A.5.18', 'Access rights reviews']]) {
      await ui.pageAction(ayu.page, 'New evidence').click();
      const dialog = ui.modal(ayu.page);
      await expect(dialog).toContainText('New evidence');
      await dialog.locator('input[name="code"]').fill(code);
      await dialog.locator('input[name="title"]').fill(title);
      await dialog.locator('select[name="frequencyCode"]').selectOption('quarterly');
      await dialog.locator('input[type="search"]').first().fill(target);
      await dialog.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${esc(target)}(?!\\d)`) }).first().click();
      await run.firstOverlay(ayu, 'New evidence');
      await button(dialog, 'Create evidence').click();
      await expect(dialog).toContainText('Attach the first file');
      await button(dialog, 'Later').click();
      await expect(ui.modal(ayu.page)).toHaveCount(0);
      found[key] = code;
    }
  });

  test('beta: the administrator creates the QMS and invites Eka of Alpha, who accepts and gets a role', async ({ browser }) => {
    const budi = await run.as(browser, BETA.admin.key);
    await run.go(budi, 'Management systems');
    await ui.pageAction(budi.page, 'New management system').click();
    const drawer = ui.drawer(budi.page);
    const field = (name) => drawer.locator(`[name="${name}"]`);
    await field('code').fill(QMS.code);
    await expect(field('slug')).toHaveValue(QMS.slug);
    await field('name').fill(QMS.name);
    await drawer.locator('select').first().selectOption(QMS.edition);
    await field('scopeStatement').fill(QMS.scope);
    await drawer.getByLabel(QMS.colour).check();
    await drawer.locator('select').last().selectOption({ label: 'Managed Vault' });
    await button(drawer, 'Save').click();
    await run.expectToast(budi.page, new RegExp(`${QMS.code} created`));

    // Eka already has an account (in Alpha): the invitation is a banner in her app.
    await run.go(budi, 'People and roles');
    await ui.pageAction(budi.page, 'Invite person').click();
    const dialog = ui.modal(budi.page);
    await dialog.locator('[name="email"]').fill(ALPHA.member.email);
    await dialog.locator('[name="displayName"]').fill(ALPHA.member.name);
    await button(dialog, 'Send invitation').click();
    await run.expectToast(budi.page, `Invitation sent to ${ALPHA.member.email}`);

    const eka = await run.as(browser, ALPHA.member.key);
    await eka.page.goto('/');
    const banner = eka.page.locator('section.mx-invite');
    await expect(banner).toContainText(`You were invited to ${BETA.name}`);
    await run.firstVisit(eka, 'the invitation banner', PANEL_SCOPE.replace('div.mscd[role] *', 'section.mx-invite *'));
    await button(banner, 'Accept').click();
    await run.expectToast(eka.page, `You joined ${BETA.name}.`);

    await run.reloadApp(budi);
    await run.go(budi, 'People and roles');
    await budi.page.locator('main table tbody tr', { hasText: ALPHA.member.email }).click();
    const personDrawer = ui.drawer(budi.page);
    await button(personDrawer, 'Grant role').click();
    const grant = ui.modal(budi.page);
    await grant.locator('[name="ms"]').selectOption(QMS.slug);
    await grant.locator('[name="role"]').selectOption({ label: 'Domain Owner' });
    await button(grant, 'Grant role').click();
    await run.expectToast(budi.page, 'Role granted');
    await run.closeLayers(budi.page);
  });

  test('read confirmation: POL-01 needs confirmation, Dimas approves its first version, Eka and Fajar confirm it, and the register is filed as evidence', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    await run.reloadApp(ayu);
    await run.go(ayu, 'Document register', { ms: ISMS.code });
    await ui.pageAction(ayu.page, 'New document').click();
    const form = ui.drawer(ayu.page);
    await expect(form).toContainText('New document');
    await form.getByLabel(/^Start from a template/).selectOption(ALPHA.policy);
    await expect(form.getByLabel(/^Document code/)).toHaveValue(ALPHA.policy);
    await selectPerson(form.getByLabel(/^Owner/), ALPHA.admin.name);
    await selectPerson(form.getByLabel(/^Approver/), ALPHA.second.name);
    await run.firstOverlay(ayu, 'New document');
    await button(form, 'Register document').click();
    await run.expectToast(ayu.page, `${ALPHA.policy} registered as a draft`);

    // The read confirmation setting of the document (D.7): everyone with a role in the ISMS, 14 days.
    const section = ui.drawer(ayu.page).locator(`[data-read-confirmation="${ALPHA.policy}"]`);
    await expect(section).toContainText('Read confirmation');
    await button(section, 'Read confirmation settings').click();
    const settings = ui.modal(ayu.page).last();
    await expect(settings).toContainText(`Read confirmation of ${ALPHA.policy}`);
    await settings.getByLabel('Ask people to confirm each new approved version').check();
    await expectOverlayReadable(ayu.page, 'the read confirmation settings');
    await button(settings, 'Save').click();
    await run.expectToast(ayu.page, `Read confirmation of ${ALPHA.policy} saved`);
    await expect(section.locator('[data-setting]')).toHaveText('Each new approved version is sent for read confirmation: Everyone with a role in the document\'s systems, 14 days.');

    const panel = ui.drawer(ayu.page).locator('[data-docs-edit]');
    await button(panel, 'Attach first version').click();
    const upload = ui.modal(ayu.page);
    await expect(upload).toContainText('Managed Vault: the file is uploaded, versioned and SHA-256 checksummed by the application.');
    const chooser = ayu.page.waitForEvent('filechooser');
    await button(upload, 'Upload to Managed Vault').click();
    await (await chooser).setFiles({ name: `${ALPHA.policy} Information security policy.pdf`, mimeType: 'application/pdf', buffer: policyPdf() });
    const submit = ui.modal(ayu.page).last();
    await expect(submit).toContainText(`First version of ${ALPHA.policy}`);
    await submit.locator('textarea').fill('First issue of the information security policy for the ISMS scope');
    await button(submit, 'Submit for review').click();
    await run.expectToast(ayu.page, new RegExp(`${ALPHA.policy} v[\\d.]+ submitted for review`));
    await run.closeLayers(ayu.page);

    // Dimas, the approver, approves it: the approval asks everyone with a role in the ISMS to confirm it.
    const dimas = await run.as(browser, ALPHA.second.key);
    await run.reloadApp(dimas);
    await run.go(dimas, 'Document register', { ms: ISMS.code });
    await openRow(dimas.page, ALPHA.policy);
    await drawerAction(dimas.page, 'Open review').click();
    const review = ui.modal(dimas.page).last();
    await expect(review).toContainText(`Review of ${ALPHA.policy}`);
    await run.firstOverlay(dimas, 'the review of a document');
    await button(review, 'Approve').click();
    await run.expectToast(dimas.page, new RegExp(`${ALPHA.policy} v[\\d.]+ approved`));
    await run.closeLayers(dimas.page);
    const requests = await apiJson(ayu, `/api/v1/ms/${ISMS.slug}/acknowledgement-requests`);
    const request = (Array.isArray(requests) ? requests : requests.items).find((r) => r.document.code === ALPHA.policy && r.status === 'open');
    expect(request, `the open confirmation request of ${ALPHA.policy}`).toBeTruthy();
    expect(request.totals).toMatchObject({ audience: 4, confirmed: 0, pending: 4 });
    const version = request.version.label;
    found.policyVersion = version;

    // Eka and Fajar open the version and confirm it in "Policies to confirm".
    for (const key of [ALPHA.member.key, ALPHA.leaver.key]) {
      const s = await run.as(browser, key);
      await run.reloadApp(s);
      await run.go(s, 'Policies to confirm');
      const item = s.page.locator(`main [data-screen="my-confirmations"] [data-confirmation="${ALPHA.policy}"]`);
      await expect(item).toContainText(`Version ${version}`);
      await expect(item).toContainText('Not opened yet');
      await expect(button(item, 'Confirm')).toBeDisabled();
      const popup = s.page.waitForEvent('popup');
      const opened = s.page.waitForResponse((r) => /\/api\/v1\/me\/acknowledgements\/[^/]+\/open$/.test(new URL(r.url()).pathname));
      await button(item, 'Open document').click();
      expect((await opened).status()).toBe(200);
      await (await popup).close();
      await expect(item).toContainText(/Opened on/);
      await item.getByLabel('I have read and understood this document').check();
      await button(item, 'Confirm').click();
      await run.expectToast(s.page, `You confirmed ${ALPHA.policy} version ${version}`);
      await expect(s.page.locator('main [data-screen="my-confirmations"]')).toContainText('Nothing to confirm');
    }

    // Ayu sees 2 of 4 confirmed and closes the request into the evidence item of A.5.1.
    await run.reloadApp(ayu);
    await run.go(ayu, 'Policy read confirmations', { ms: ISMS.code });
    const requestRow = ayu.page.locator('main [data-screen="acknowledgements"] tbody tr', { hasText: ALPHA.policy }).first();
    await expect(requestRow).toContainText('2 of 4');
    await requestRow.click();
    const detail = ui.drawer(ayu.page);
    await expect(detail).toContainText(`${ALPHA.policy} version ${version}`);
    await expect(detail.locator('tbody tr', { hasText: ALPHA.member.name })).toContainText('Confirmed');
    await expect(detail.locator('tbody tr', { hasText: ALPHA.leaver.name })).toContainText('Confirmed');
    await run.firstOverlay(ayu, 'a confirmation request');
    await button(detail, 'Close and file as evidence').click();
    const close = ui.modal(ayu.page).last();
    await expect(close).toContainText(`Close the request of ${ALPHA.policy}`);
    await close.locator('input[type="search"]').fill(found.policyEvidence);
    await close.locator('[role="option"]', { hasText: found.policyEvidence }).click();
    await expectOverlayReadable(ayu.page, 'the closing of a confirmation request');
    await button(close, 'Close and file').click();
    await run.expectToast(ayu.page, `Request closed. The register is filed as a new file of ${found.policyEvidence}.`);
    await expect(detail).toContainText('This request is closed. Reminders stopped.');
    await run.closeLayers(ayu.page);
  });

  test('retention: a lapsed competence record, 1 month for its record type, the daily review, a disposal proposed by Ayu and approved by Dimas', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    const today = todayIn(ALPHA.timeZone);
    const c = ALPHA.competence;
    // The competence record of Eka's training, which lapsed 60 days ago.
    await run.go(ayu, 'Registers', { ms: ISMS.code });
    await openTab(ayu.page, 'Competence');
    await button(list(ayu.page), 'Add').click();
    const drawer = ui.drawer(ayu.page);
    await expect(drawer).toContainText('Add to Competence');
    await selectPerson(drawer.locator('.mx-field').filter({ hasText: /^Person/ }).locator('select'), ALPHA.member.name);
    await drawer.getByLabel(/^Role/).fill(c.role);
    await drawer.getByLabel(/^Competence required/).fill(c.required);
    await drawer.locator('select[name="proofType"]').selectOption('training');
    await drawer.getByLabel(/^Achieved on/).fill(addDays(today, -c.achievedDaysAgo));
    await drawer.getByLabel(/^Valid until/).fill(addDays(today, -c.validUntilDaysAgo));
    await selectPerson(drawer.locator('select[name="ownerHandle"]'), ALPHA.admin.name);
    await run.firstOverlay(ayu, 'Add to Competence');
    const added = ayu.page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/ms/${ISMS.slug}/registers/competence` && r.request().method() === 'POST');
    await button(drawer, 'Save').click();
    expect((await added).status()).toBeLessThan(300);
    await run.expectToast(ayu.page, /CMP-[0-9A-F]{8} added/);
    const code = /CMP-[0-9A-F]{8}/.exec(await ui.toast(ayu.page).innerText())[0];
    found.competenceCode = code;
    await run.closeLayers(ayu.page);

    // 1 month for lapsed competence records, with its basis.
    await run.go(ayu, 'Retention and disposal', { ms: ISMS.code });
    await openTab(ayu.page, 'Rules');
    const rule = rows(ayu.page.locator('main')).filter({ hasText: 'Lapsed competence records' }).first();
    await expect(rule).toContainText('36 months');
    await button(rule, 'Edit').click();
    const dialog = ui.modal(ayu.page);
    await expect(dialog).toContainText('Retention period of Lapsed competence records');
    await dialog.locator('input[name="months"]').fill('1');
    await dialog.locator('textarea[name="basis"]').fill('Training records are kept one month after they lapse (lifecycle test of the service)');
    await run.firstOverlay(ayu, 'the retention period of a record type');
    await button(dialog, 'Save').click();
    await run.expectToast(ayu.page, 'Retention period saved');
    await expect(rule).toContainText('1 month');

    // The daily review of the organisation (03:15 local time on a server) opens the review of the record.
    const sent = startRetentionReview(found.alphaId, today);
    expect(sent, 'the queued retention.review job').toMatch(/\S/);
    await until(() => apiJson(ayu, `/api/v1/ms/${ISMS.slug}/retention/reviews`), (page) => page.items.some((r) => r.itemCode === code), { what: `the disposal review of ${code}` });
    await openTab(ayu.page, 'Due for review');
    const due = rows(ayu.page.locator('main')).filter({ hasText: code });
    await expect(due).toHaveCount(1);
    await run.firstVisit(ayu, 'Retention and disposal, due for review');
    await due.locator('input[type="checkbox"]').check();
    await button(ayu.page.locator('main'), 'Decide for 1 selected').click();
    await dialog.getByLabel('Propose disposal').check();
    await expect(dialog).toContainText('A second person must approve.');
    await dialog.locator('textarea[name="reason"]').fill('The training lapsed and its retention period ended; a newer record replaces it');
    await expectOverlayReadable(ayu.page, 'the disposal decision');
    await button(dialog, 'Save decision').click();
    await run.expectToast(ayu.page, 'Decision saved for 1 record(s)');
    await openTab(ayu.page, 'Awaiting approval');
    const mine = rows(ayu.page.locator('main')).filter({ hasText: code });
    await expect(mine).toContainText('You proposed this disposal');
    await expect(button(mine, 'Approve')).toBeDisabled();

    // Dimas, the second Management System Manager, approves it.
    const dimas = await run.as(browser, ALPHA.second.key);
    await run.go(dimas, 'Retention and disposal', { ms: ISMS.code });
    await openTab(dimas.page, 'Awaiting approval');
    const waiting = rows(dimas.page.locator('main')).filter({ hasText: code });
    await expect(waiting).toContainText(ALPHA.admin.name);
    await button(waiting, 'Approve').click();
    const approve = ui.modal(dimas.page);
    await expect(approve).toContainText(`Approve the disposal of ${code}`);
    await expect(approve).toContainText('cannot be undone');
    await run.firstOverlay(dimas, 'the approval of a disposal');
    await button(approve, 'Approve and dispose').click();
    await run.expectToast(dimas.page, `${code} disposed of`);
    await openTab(dimas.page, 'Disposal register');
    await expect(rows(dimas.page.locator('main')).filter({ hasText: code })).toContainText('Disposed of');
    await run.firstVisit(dimas, 'the disposal register');
  });

  test('access review: started by Ayu, decided by both managers, the leaver\'s role revoked, signed off and filed as evidence of A.5.18', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    const dimas = await run.as(browser, ALPHA.second.key);
    const dialog = (page) => ui.modal(page);
    /** Decides one item: keep, or revoke with a note. */
    const decide = async (s, row, { revoke = null } = {}) => {
      await button(row, 'Decide').click();
      if (revoke) {
        await dialog(s.page).getByLabel('Revoke: the access is no longer needed').check();
        await dialog(s.page).locator('textarea[name="note"]').fill(revoke);
      } else await dialog(s.page).getByLabel('Keep: the access is still needed').check();
      await run.firstOverlay(s, 'an access review decision');
      await button(dialog(s.page), 'Save decision').click();
      await run.expectToast(s.page, 'Decision saved for 1 item(s)');
      await expect(dialog(s.page)).toHaveCount(0);
    };
    /** Keeps every item a card still shows undecided (the person's own items are not offered). */
    const keepTheRest = async (s, scope) => {
      await scope.locator('select[name="decided"]').selectOption('undecided');
      if ((await scope.getByLabel('Select every item shown').count()) === 0) return;
      await scope.getByLabel('Select every item shown').check();
      await scope.locator('.mx-card-head button', { hasText: /^Decide for \d+ selected$/ }).click();
      await dialog(s.page).getByLabel('Keep: the access is still needed').check();
      await button(dialog(s.page), 'Save decision').click();
      await run.expectToast(s.page, /Decision saved for \d+ item\(s\)/);
      await expect(dialog(s.page)).toHaveCount(0);
      await scope.locator('select[name="decided"]').selectOption('');
    };
    /**
     * Access reviews, then the page of the open review ("Open review" on the card of the same name), loaded afresh: the
     * screen keeps the review it shows when its sidebar entry is chosen again, so the run goes back to the list first.
     */
    const openReview = async (s) => {
      await run.go(s, 'Access reviews');
      const back = button(s.page.locator('main'), 'Back to access reviews');
      if (await back.count()) await back.click();
      await button(card(s.page, '^Open review$'), 'Open review').click();
      await expect(s.page.locator('main [data-review]')).toBeVisible();
      await run.settle(s.page);
    };

    await run.go(ayu, 'Access reviews');
    await button(card(ayu.page, '^Open review'), 'Start review now').click();
    await run.expectToast(ayu.page, /Access review AR-\d{4}-\d{2} started with \d+ item\(s\) to review/);
    const reviewNo = /AR-\d{4}-\d{2}/.exec(await ui.toast(ayu.page).innerText())[0];
    found.reviewNo = reviewNo;
    await expect(ayu.page.locator('main [data-review]')).toBeVisible();
    await run.firstVisit(ayu, 'an open access review');

    // The ISMS: Ayu decides the others' roles and revokes the leaver's; her own role needs Dimas.
    await run.go(ayu, 'Access review of this system', { ms: ISMS.code });
    const head = card(ayu.page, `^${ISMS.code} in access review ${reviewNo}`);
    await expect(head).toBeVisible();
    const items = card(ayu.page, '^Business roles and guest auditors');
    // Her own access waits for the other reviewer (REVIEW-OWN-ACCESS); Dimas decides it below.
    await expect(personRows(items, ALPHA.admin.name).first()).toContainText('Your own access: another reviewer decides it');
    await decide(ayu, personRows(items, ALPHA.leaver.name).first(), { revoke: 'Leaves the company at the end of the month' });
    await keepTheRest(ayu, items);
    await run.go(dimas, 'Access review of this system', { ms: ISMS.code });
    const dimasItems = card(dimas.page, '^Business roles and guest auditors');
    await decide(dimas, personRows(dimasItems, ALPHA.admin.name).filter({ hasText: 'Management System Manager' }).first());

    // The organisation's access: each Tenant Admin decides the other people's items.
    await openReview(ayu);
    await keepTheRest(ayu, card(ayu.page, '^Organisation access'));
    await openReview(dimas);
    await keepTheRest(dimas, card(dimas.page, '^Organisation access'));

    // Ayu applies the revocation, signs the ISMS off into the evidence of A.5.18 and completes the review.
    await openReview(ayu);
    const apply = card(ayu.page, '^Revocations and changes to apply');
    const waiting = personRows(apply, ALPHA.leaver.name);
    await expect(waiting).toContainText('Leaves the company at the end of the month');
    await button(waiting, 'Apply').click();
    await run.expectToast(ayu.page, 'Role revoked');
    await expect(personRows(apply, ALPHA.leaver.name)).toHaveCount(0);

    await run.go(ayu, 'Access review of this system', { ms: ISMS.code });
    await button(head, 'Sign off').click();
    await expect(dialog(ayu.page)).toContainText(`${found.accessEvidence} covers control A.5.18 (access rights) and is proposed.`);
    await expectOverlayReadable(ayu.page, 'the sign-off of a system');
    await button(dialog(ayu.page), 'Sign off').click();
    await run.expectToast(ayu.page, `${ISMS.code} signed off; its rows are filed to ${found.accessEvidence} when the review completes`);
    await expect(head).toContainText('Signed off');

    await openReview(ayu);
    const reviewHead = ayu.page.locator('main [data-review] section.mx-card').first();
    await button(reviewHead, 'Complete').click();
    await run.expectToast(ayu.page, `Access review ${reviewNo} completed; the rows of 1 system(s) were filed as evidence`);
    await expect(reviewHead).toContainText('Completed');
    await expect(card(ayu.page, '^Systems')).toContainText(found.accessEvidence);
    await run.firstVisit(ayu, 'a completed access review');
    const report = await downloaded(ayu.page, () => button(reviewHead, 'Download report').click());
    expect(report.name).toBe(`access-review-${reviewNo}-${ALPHA.slug}.csv`);
    const csv = report.bytes.toString('utf8');
    expect(csv.split(/\r\n/)[0]).toMatch(/^review_no,opened_on,due_on,system,item_kind,person,handle,role,/);
    expect(csv).toContain(ALPHA.leaver.name);
  });

  test('Eka downloads "My data" from My account', async ({ browser }) => {
    const eka = await run.as(browser, ALPHA.member.key);
    await run.reloadApp(eka);
    const me = await apiJson(eka, '/api/v1/me');
    expect((me.data ?? me).org?.slug, 'Eka works in Alpha').toBe(ALPHA.slug);
    await eka.page.locator('header button[data-topbar="account"]').click();
    await expect(ui.title(eka.page)).toHaveText('My account');
    await run.settle(eka.page);
    await run.firstVisit(eka, 'My account');
    const myData = eka.page.locator('main section.mx-card').filter({ has: eka.page.locator('h2', { hasText: /^My data$/ }) });
    const file = await downloaded(eka.page, () => button(myData, 'Download my data').click(), { timeout: 90_000 });
    await run.expectToast(eka.page, 'Your data is downloaded');
    const data = JSON.parse(file.bytes.toString('utf8'));
    expect(JSON.stringify(data)).toContain(ALPHA.member.email);
  });

  test('requests from one person: Eka\'s access request is answered with a copy of her data, and the leaver Fajar is erased after the system check', async ({ browser }) => {
    const ayu = await run.as(browser, ALPHA.admin.key);
    const drawer = ui.drawer(ayu.page);
    const dialog = ui.modal(ayu.page);
    /** Records a request of a member on screen and starts work on it; returns its number. */
    const record = async (type, p, note) => {
      await run.go(ayu, 'Personal data requests');
      await ui.pageAction(ayu.page, 'Record request').click();
      await expect(dialog).toContainText('Record a personal data request');
      await dialog.locator('select').first().selectOption(type);
      await dialog.locator('input[type="search"]').fill(p.name);
      await dialog.locator('[role="option"]', { hasText: p.name }).first().click();
      await dialog.locator('textarea').fill(note);
      await run.firstOverlay(ayu, 'Record a personal data request');
      await button(dialog, 'Record').click();
      await run.expectToast(ayu.page, /Request PR-\d{4}-\d{3} recorded/);
      const no = /PR-\d{4}-\d{3}/.exec(await ui.toast(ayu.page).innerText())[0];
      await expect(drawer).toContainText(`Request ${no}`);
      await expect(drawer).toContainText(p.name);
      await button(drawer, 'Start work').click();
      await dialog.locator('textarea').fill('Asked from the work email address the organisation knows, confirmed by a video call');
      await button(dialog, 'Start work').click();
      await run.expectToast(ayu.page, `Work on ${no} started`);
      return no;
    };
    /** The primary Management System Manager of the ISMS (Ayu) marks the system check done. */
    const check = async (no, note) => {
      await run.go(ayu, 'Personal data checks', { ms: ISMS.code });
      await rows(ayu.page.locator('main')).filter({ hasText: no }).click();
      await button(drawer, 'Mark checked').click();
      await dialog.locator('textarea').fill(note);
      await run.firstOverlay(ayu, 'the system check of a request');
      await button(dialog, 'Mark checked').click();
      await run.expectToast(ayu.page, `The check of ${no} is done`);
      // The list reads the checks again: the drawer goes while it loads and comes back with the done status. Close it
      // only once it is back, or it returns over the next click.
      await expect(drawer.locator(`[data-check="${no}"]`)).toContainText(/Done/);
      await run.closeLayers(ayu.page);
      await expect(drawer).toHaveCount(0);
    };
    const open = async (no) => {
      await run.go(ayu, 'Personal data requests');
      await rows(ayu.page.locator('main')).filter({ hasText: no }).click();
      await expect(drawer).toContainText(`Request ${no}`);
    };
    const closeWith = async (no, answer) => {
      await button(drawer, 'Close with the answer').click();
      await dialog.locator('textarea').fill(answer);
      await button(dialog, 'Close with the answer').click();
      await run.expectToast(ayu.page, `Request ${no} completed`);
      await run.closeLayers(ayu.page);
    };

    // Access: a copy of Eka's data after the check of the ISMS.
    const access = await record('access', ALPHA.member, 'Eka asks for a copy of the personal data the organisation holds about her');
    await run.firstOverlay(ayu, 'a personal data request');
    await run.closeLayers(ayu.page);
    await check(access, 'Searched the ISMS records; only her competence record and her confirmation name her');
    await open(access);
    await button(drawer, 'Prepare a copy of the data').click();
    await run.expectToast(ayu.page, 'The copy is being prepared.');
    const copy = await until(async () => {
      const [download] = await Promise.all([
        ayu.page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        button(drawer, 'Download the copy').click(),
      ]);
      return download;
    }, (d) => d !== null, { timeoutMs: 120_000, intervalMs: 3000, what: 'the copy of the data' });
    expect(copy.suggestedFilename()).toMatch(/^personal-data-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.json$/);
    expect(readFileSync(await copy.path(), 'utf8')).toContain(ALPHA.member.email);
    await closeWith(access, 'Sent the copy of her data to her work email address');

    // Erasure: the leaver, whose role the access review revoked, after the check of the ISMS.
    const erasure = await record('erasure', ALPHA.leaver, 'Fajar left the company and asks to be erased from MSCD');
    await run.closeLayers(ayu.page);
    await check(erasure, 'Searched the ISMS records; none names him apart from his confirmation');
    await open(erasure);
    await button(drawer, 'Erase the person').click();
    await expect(dialog).toContainText('This cannot be undone.');
    await expect(dialog).toContainText('What stays');
    const confirm = button(dialog, 'Erase the person');
    await expect(confirm).toBeDisabled();
    await dialog.locator('input').fill('ERASE');
    await expectOverlayReadable(ayu.page, 'the erasure of a person');
    // The leaver's own session ends with the erasure: his open page is signed out at its next read.
    run.expectedNow.push({ who: ALPHA.leaver.key, status: 401, method: 'GET', path: /^\/api\/v1\// });
    await confirm.click();
    await run.expectToast(ayu.page, `The person of ${erasure} is erased in this organisation`);
    await closeWith(erasure, 'Erased in MSCD; the records keep the pseudonym as audit evidence');
    // The organisation now shows the leaver under the pseudonym only.
    const users = await apiJson(ayu, '/api/v1/admin/users?pageSize=200');
    expect(JSON.stringify(users)).not.toContain(ALPHA.leaver.email);
  });

  test('offboarding: the operator moves Alpha to offboarding and Ayu downloads every part of the final export, each SHA-256 checked against the manifest', async ({ browser }) => {
    const op = await run.as(browser, 'operator');
    // The rest of the run moves Alpha by the operator's hand: the hourly schedule of org.lifecycle must not do it first.
    await awayFromLifecycleSchedule(op.page, 15);
    await run.moveStatus(op, ALPHA, 'Start offboarding', 'Contract ended on 31 October; read-only period for the final export');
    // During offboarding the organisation is read-only (D-S5): a write of one of its people answers 403.
    run.expectedNow.push({ who: ALPHA_PEOPLE, status: 403, method: 'POST', path: /^\/api\/v1\// });
    // The end of the read-only period as the server holds it. The run sets the period to 0 days while the texts of the
    // screens name the default periods, so the dates the screens show are checked against the server's (M3-09).
    const offboarding = await opsOrg(op, ALPHA);
    const endsAt = (offboarding.data ?? offboarding).offboardingEndsAt;
    expect(endsAt, 'offboardingEndsAt of the operator route').toBeTruthy();
    const endsOn = browserDay(endsAt);
    await run.operatorOrganisations(op);
    const readOnlyCell = run.orgRow(op.page, ALPHA).locator('[data-read-only-until]');
    await expect(readOnlyCell).toHaveAttribute('data-read-only-until', endsOn);
    await expect(readOnlyCell).toHaveText(shownDay(endsOn));

    const ayu = await run.as(browser, ALPHA.admin.key);
    await run.reloadApp(ayu);
    const exports = await until(() => apiJson(ayu, '/api/v1/admin/organization/exports'), (items) => items.some((e) => e.isFinal && e.status === 'ready'), {
      timeoutMs: 300_000, intervalMs: 3000, what: 'the final export',
    });
    const final = exports.find((e) => e.isFinal && e.status === 'ready');
    await run.go(ayu, 'Organisation export');
    const note = ayu.page.locator('main [data-read-only-note]');
    await expect(note).toContainText('Download the final export before then');
    // The title of the note names the same day as the operator console: "Read-only until <day>".
    const noteTitle = ayu.page.locator('main .mx-alert', { has: ayu.page.locator('[data-read-only-note]') }).locator('.mx-alert-title');
    await expect(noteTitle).toHaveText(new RegExp(`^Read-only until ${shownDay(endsOn).source}$`));
    const row = ayu.page.locator('main [data-org-export] table tbody tr').filter({ has: ayu.page.locator('[data-export-status="ready"]') }).first();
    await expect(row).toContainText('Not needed: end of contract');
    await button(row, 'Open').click();
    const drawer = ui.drawer(ayu.page);
    await expect(drawer.locator('[data-sha256]')).toHaveCount(final.partCount + 1);
    await expectOverlayReadable(ayu.page, 'the final export');
    const shown = await drawer.locator('[data-sha256]').allInnerTexts();
    const buttons = drawer.getByRole('button', { name: 'Download' });
    const files = [];
    for (let i = 0; i < final.partCount + 1; i += 1) files.push(await downloaded(ayu.page, () => buttons.nth(i).click(), { timeout: 120_000 }));
    files.forEach((f, i) => expect(sha256(f.bytes), `the SHA-256 of ${f.name}`).toBe(shown[i].trim()));
    const manifest = JSON.parse(files.at(-1).bytes.toString('utf8'));
    expect(manifest).toMatchObject({ format: expect.any(String), copy: 'download', exportId: final.id, isFinal: true, organization: { id: found.alphaId, slug: ALPHA.slug } });
    expect(manifest.parts).toHaveLength(final.partCount);
    for (const [i, part] of manifest.parts.entries()) {
      expect(files[i].name, `part ${part.part}`).toBe(part.name);
      expect(files[i].bytes.length, `the size of ${part.name}`).toBe(part.sizeBytes);
      expect(sha256(files[i].bytes), `the SHA-256 of ${part.name} against the manifest`).toBe(part.sha256);
    }
    // The export holds the policy file and the records of the run.
    expect(manifest.counts.files).toBeGreaterThan(0);
    expect(manifest.entries.some((e) => e.path.startsWith('files/') && e.path.includes(ALPHA.policy))).toBe(true);
    found.finalExport = { id: final.id, manifestSha256: sha256(files.at(-1).bytes) };
    await run.closeLayers(ayu.page);
  });

  test('deletion: org.lifecycle archives Alpha, the date is set to now, org.lifecycle runs again and the purge completes with a signed certificate', async ({ browser }) => {
    const op = await run.as(browser, 'operator');
    // Archiving ends every session of Alpha: its people's open pages are signed out at their next read.
    run.expectedNow.push({ who: ALPHA_PEOPLE, status: 401, method: 'GET', path: /^\/api\/v1\// });
    await runJob(op, 'org.lifecycle');
    await until(() => opsOrg(op, ALPHA), (o) => (o.data ?? o).status === 'archived', { what: 'Alpha archived' });
    await run.operatorOrganisations(op);
    await expect(run.orgRow(op.page, ALPHA)).toContainText('Archived');

    // The deletion is scheduled; the operator sets its date to today (the minimum grace of the run is 0 days), which the
    // form turns into the first minute from now. The operator's browser counts days as the installation does (Jakarta).
    const today = todayIn(ALPHA.timeZone);
    const drawer = await run.manage(op, ALPHA, 'Deletion');
    await expect(drawer.locator('[data-deletion="scheduled"]')).toBeVisible();
    await button(drawer, 'Change date').click();
    const dialog = ui.modal(op.page);
    await dialog.locator('input[type="date"]').fill(today);
    await dialog.locator('textarea').fill('The customer confirmed in writing that the final export is complete');
    await dialog.locator('input[type="text"]').fill(ALPHA.slug);
    await expectOverlayReadable(op.page, 'the date of a deletion');
    await button(dialog, 'Change date').click();
    await run.expectToast(op.page, `The deletion of ${ALPHA.slug} is scheduled for ${today}.`);
    await run.closeLayers(op.page);
    // The "Deletion on" column names the day of the server's scheduledFor, in the organisation list's own route too.
    const scheduledFor = (await apiJson(op, `/api/v1/ops/organizations/${ALPHA.slug}/deletion`)).scheduledFor;
    const scheduledOrg = await opsOrg(op, ALPHA);
    expect(Date.parse((scheduledOrg.data ?? scheduledOrg).deletion?.scheduledFor), 'the deletion date of the organisation route').toBe(Date.parse(scheduledFor));
    const deletionOn = browserDay(scheduledFor);
    expect(deletionOn, 'the deletion date set to today').toBe(today);
    await run.operatorOrganisations(op);
    const deletionCell = run.orgRow(op.page, ALPHA).locator('[data-deletion-on]');
    await expect(deletionCell).toHaveAttribute('data-deletion-on', deletionOn);
    await expect(deletionCell).toContainText(shownDay(deletionOn));

    // org.lifecycle starts the purge only once its date has come: wait for that minute, then run it again.
    const due = Date.parse(scheduledFor);
    expect(due - Date.now(), 'the deletion is due within minutes').toBeLessThan(5 * 60_000);
    if (due > Date.now()) await op.page.waitForTimeout(due - Date.now() + 2000);
    await runJob(op, 'org.lifecycle');
    const deletion = await until(() => apiJson(op, `/api/v1/ops/organizations/${ALPHA.slug}/deletion`), (d) => ['completed', 'failed'].includes(d.status), {
      timeoutMs: 300_000, intervalMs: 3000, what: 'the purge of Alpha',
    });
    expect(deletion.status, `the purge of Alpha ended with ${deletion.failedStep}: ${deletion.error}`).toBe('completed');
    expect(deletion.certificateId).toMatch(/^[0-9a-f-]{36}$/);
    await run.operatorOrganisations(op);
    await expect(run.orgRow(op.page, ALPHA)).toContainText('Deleted');
    const done = await run.manage(op, ALPHA, 'Deletion');
    await expect(done.locator('[data-deletion="completed"]')).toContainText('The organisation is deleted.');
    await expect(done.locator('[data-step="check: data key"]')).toHaveText('Check: the data key is gone');
    const certificate = await downloaded(op.page, () => button(done, 'Download certificate').click());
    await run.expectToast(op.page, 'Certificate download started');
    await run.closeLayers(op.page);

    const doc = JSON.parse(certificate.bytes.toString('utf8'));
    const body = doc.certificate ?? doc;
    expect(JSON.stringify(body)).toContain('mscd-deletion-certificate-v1');
    expect(JSON.stringify(body)).toContain(found.alphaId);
    expect(JSON.stringify(body)).toContain(found.finalExport.id);

    // The certificate passes the check of the release in the stack's own cli container.
    const folder = path.join(state.stateDir, 'certificates');
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    chmodSync(folder, 0o755);
    const file = path.join(folder, `deletion-certificate-${ALPHA.slug}.json`);
    writeFileSync(file, certificate.bytes, { mode: 0o644 });
    chmodSync(file, 0o644);
    const checked = run.composeRun('cli', ['tenant', 'verify-certificate', `/run/certificates/${path.basename(file)}`, '--json'], { profile: 'cli', volumes: [`${folder}:/run/certificates:ro`] });
    expect(checked.status, `tenant verify-certificate: ${checked.stdout}\n${checked.stderr}`).toBe(0);
    const verdict = JSON.parse(checked.stdout);
    expect(verdict).toMatchObject({ ok: true, certificateId: deletion.certificateId });

    // The Tenant Admins captured when the deletion was scheduled get the certificate by email.
    for (const admin of [ALPHA.admin, ALPHA.second]) {
      await waitForMail(admin.email, new RegExp(`${esc(ALPHA.name)} was deleted from MSCD: deletion certificate`), { timeoutMs: 120_000 });
    }
  });

  test('after the deletion: Alpha\'s sign-in shows no organisation, Beta keeps working and Eka works on in Beta', async ({ browser }) => {
    // Discovery answers Alpha's slug as it answers a slug that never existed.
    const stranger = await run.person(browser, 'stranger', { fresh: true });
    const answers = [];
    for (const slug of ['zz_unknown_org', ALPHA.slug]) {
      const lookup = stranger.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/providers' && new URL(r.url()).searchParams.get('org') === slug);
      await stranger.page.goto(`/login?org=${slug}`);
      const res = await lookup;
      answers.push({ status: res.status(), body: await res.text() });
    }
    expect(answers[1], 'discovery of the deleted Alpha answers as for an unknown slug').toEqual(answers[0]);

    // Ayu's account belonged to Alpha alone and was anonymised: her email and password open nothing.
    const ayu = await run.person(browser, ALPHA.admin.key, { fresh: true });
    await ayu.page.goto('/login');
    await expect(ayu.page.locator('#au-email')).toBeVisible();
    await ayu.page.waitForLoadState('networkidle');
    await ayu.page.locator('#au-email').fill(ALPHA.admin.email);
    await ayu.page.locator('#au-password').fill(PASSWORD);
    await expect(ayu.page.locator('#au-email')).toHaveValue(ALPHA.admin.email);
    await run.expecting([{ who: ALPHA.admin.key, status: 401, method: 'POST', path: /^\/api\/v1\/auth\/login/ }], async () => {
      await ayu.page.locator('.au-form button[type="submit"]').click();
      await expect(ayu.page.locator('div.au-alert[role="alert"]')).toContainText('The email or password is not correct, or the account cannot sign in now.');
    });
    await expectReadableText(ayu.page, 'the refused sign-in of an erased account');

    // Beta keeps working, and Eka, a member of both, signs in to Beta, her only organisation now.
    const budi = await run.as(browser, BETA.admin.key);
    await run.reloadApp(budi);
    await run.go(budi, 'People and roles');
    await expect(budi.page.locator('main table tbody tr', { hasText: ALPHA.member.email })).toBeVisible();
    const eka = await run.person(browser, ALPHA.member.key, { fresh: true });
    await run.signIn(eka);
    const me = await apiJson(eka, '/api/v1/me');
    const view = me.data ?? me;
    expect(view.org?.slug).toBe(BETA.slug);
    expect(JSON.stringify(view.memberships ?? view.orgs ?? [])).not.toContain(ALPHA.slug);
    await run.go(eka, 'Policies to confirm', { ms: QMS.code });
    expect((await eka.page.request.get(`/api/v1/ui/ms/${QMS.slug}`)).status()).toBe(200);
    await run.expectEssentialCookies(eka);
  });
});
