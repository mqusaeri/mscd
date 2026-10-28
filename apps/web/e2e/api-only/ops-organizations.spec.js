import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, ui, expectToast, expectOverlayReadable } from '../helpers.js';
import { DEMO_PASSWORD, demoCode, freshTotpStep } from '../../e2e-api/fixtures.js';

// The organisations of the operator console against the api (MILESTONE-2 M2-S12). The API stack runs one organisation
// (single tenancy), so the first test checks with the real api that every organisation route the console reads
// answers 409 `single_tenancy` and that the console says so. The SaaS answers of the other tests come from
// `page.route`, as in sign-in-discovery.spec.js: a small service in the shapes of the contract that checks every
// request with the schemas of @mscd/shared, follows the status machine of J.8, and checks `If-Match` with the server's
// own `entitlementEtag` and `ifMatchOf` (apps/server/dist), so the ETag the screen builds is the one the server sends.
// The operator's platform rights of a multi tenancy service are added to `GET /me`.

/** The entitlement row helpers of the server build, which the API stack builds before the run. */
const ROW_HELPERS = fileURLToPath(new URL('../../../server/dist/modules/license/entitlement-row.js', import.meta.url));

/**
 * The server's `entitlementEtag(row)` or `ifMatchOf(header, row)`, run in a plain Node process: the server build is
 * CommonJS that requires the ESM contract package, which the loader of the spec files does not take.
 */
function serverRow(op, { row = null, header } = {}) {
  const code = `const m = await import(${JSON.stringify(ROW_HELPERS)});
const { op, row, header } = JSON.parse(process.argv[1]);
const record = row && { version: row.version, updatedAt: new Date(row.updatedAt) };
process.stdout.write(JSON.stringify(op === 'etag' ? m.entitlementEtag(record) : m.ifMatchOf(header ?? undefined, record)));`;
  const input = JSON.stringify({ op, row: row && { version: row.version, updatedAt: new Date(row.updatedAt).toISOString() }, header: header ?? null });
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code, input], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`server helper failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}
const tab = (page, label) => page.locator('main [role="tab"]', { hasText: label });
const drawerTab = (page, label) => ui.drawer(page).getByRole('tab', { name: label, exact: true });
const row = (page, slug) => page.locator('main table tbody tr', { hasText: slug });

/** Rights of the operator on a multi tenancy service (F.6 tenancy rows): licences, packs and entitlements. */
const MULTI_RIGHTS = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'ops.entitlements.manage', 'license.manage', 'pack.install'];

async function signInAsOperator(page) {
  await freshTotpStep();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Work email').fill('ops@mscd.test');
  await page.locator('#au-password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByLabel('Authentication code').fill(demoCode('ops'));
  await expect(ui.title(page)).toHaveText('Operator console');
}

const problem = (status, slug, title, extra = {}) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ type: `https://mscd.cyberlentera.com/problems/${slug}`, title, status, requestId: 'req-m2s12-0001', ...extra }),
});

/**
 * A SaaS operator service in the shapes of the contract. Every request body and query is parsed with the route's schema
 * of @mscd/shared and every answer with its response schema; `calls` records what the console sent.
 */
async function saasService(page, { rights = MULTI_RIGHTS } = {}) {
  const shared = await import('@mscd/shared');
  const calls = [];
  const day = '2026-10-28';
  const at = (time) => `${day}T${time}.000Z`;
  const preset = (name, users, systems, days, grace) => shared.PlanPreset.parse({
    name, maxUsers: users, maxManagementSystems: systems, frameworks: [], storageAdapters: ['managed_vault', 'm365', 'google_drive'],
    features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: grace, validDays: days,
  });
  const presets = [preset('trial', 10, 1, 30, 7), preset('standard', 50, 3, 365, 30)];
  const record = (values) => ({
    plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, frameworks: [], storageAdapters: ['managed_vault', 'm365', 'google_drive'],
    features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30,
    validFrom: '2026-10-01', validUntil: '2027-09-30', version: 1, updatedAt: new Date(at('03:00:00')), ...values,
  });
  const orgs = {
    alpha: {
      id: '00000000-0000-4000-8000-0000000a1fa1', slug: 'alpha', name: 'PT Alpha Konsultan', status: 'active', region: 'id', createdAt: at('01:00:00'),
      memberCount: 41, systemCount: 2, entitlement: record({ version: 3, updatedAt: new Date(at('03:00:00')) }),
      domains: [{ domain: 'alpha.co.id', status: 'verified', method: 'dns', requestedAt: at('01:00:00'), verifiedAt: at('02:00:00'), lastCheckedAt: at('02:00:00'), pendingUntil: null, txtName: '_mscd-verify.alpha.co.id', found: true }],
      events: [], lastSignInAt: at('04:00:00'),
    },
    beta: {
      id: '00000000-0000-4000-8000-0000000be7a1', slug: 'beta', name: 'PT Beta Logistik', status: 'suspended', region: 'id', createdAt: at('01:30:00'),
      memberCount: 3, systemCount: 0, entitlement: null, domains: [],
      events: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'suspended', reason: 'Invoice overdue by 60 days', actor: { handle: 'ops', displayName: 'Platform Operator' }, at: at('05:00:00') }],
      lastSignInAt: null,
    },
  };
  const view = ({ entitlement: e, slug, memberCount, systemCount }) => ({
    organization: slug, plan: e.plan, source: e.source, maxUsers: e.maxUsers, maxManagementSystems: e.maxManagementSystems, frameworks: [...e.frameworks],
    storageAdapters: [...e.storageAdapters], features: [...e.features], rateUserPerMinute: e.rateUserPerMinute, rateOrgPerMinute: e.rateOrgPerMinute,
    graceDays: e.graceDays, validFrom: e.validFrom, validUntil: e.validUntil, version: e.version, updatedAt: e.updatedAt.toISOString(),
    usage: { users: memberCount, managementSystems: systemCount },
  });
  const item = (o) => shared.OpsOrganizationItem.parse({
    id: o.id, slug: o.slug, name: o.name, status: o.status, licence: o.entitlement ? { state: 'valid', validUntil: o.entitlement.validUntil ?? '9999-12-31' } : null,
    memberCount: o.memberCount, systemCount: o.systemCount, plan: o.entitlement?.plan ?? null, validUntil: o.entitlement?.validUntil ?? null,
    verifiedDomains: o.domains.filter((d) => d.status === 'verified').map((d) => d.domain), createdAt: o.createdAt,
  });
  const domainView = ({ found: _found, ...d }) => shared.OrgDomain.parse(d);
  const send = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  let verifyCalls = 0;

  await page.route(/\/api\/v1\/me(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const me = await response.json();
    me.permissions = { ...me.permissions, org: [...rights] };
    return route.fulfill({ response, json: me });
  });
  await page.route(/\/api\/v1\/ops\/(organizations|plans)(\/.*)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const parts = url.pathname.replace('/api/v1/ops/', '').split('/');
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: request.headers() });
    if (parts[0] === 'plans') return send(route, 200, presets);
    if (parts.length === 1 && method === 'GET') {
      const query = shared.OpsOrganizationListQuery.parse(Object.fromEntries(url.searchParams));
      const all = Object.values(orgs).filter((o) => (!query.status || o.status === query.status) && (!query.q || `${o.slug} ${o.name}`.toLowerCase().includes(query.q.toLowerCase())));
      return send(route, 200, { items: all.map(item), page: query.page, pageSize: query.pageSize, total: all.length });
    }
    if (parts.length === 1 && method === 'POST') {
      const create = shared.OpsOrganizationCreate.parse(body);
      orgs[create.slug] = {
        id: '00000000-0000-4000-8000-0000000c0de1', slug: create.slug, name: create.name, status: 'active', region: 'id', createdAt: at('06:00:00'), memberCount: 0, systemCount: 0,
        entitlement: create.preset ? record({ plan: create.preset, maxUsers: 10, maxManagementSystems: 1, validFrom: day, validUntil: '2026-11-26', graceDays: 7 }) : null,
        domains: [], events: [], lastSignInAt: null,
      };
      return send(route, 201, shared.OpsOrganizationCreateResult.parse({
        ok: true, changed: [],
        message: [`Organisation created. The slug ${create.slug} cannot be changed. The ${create.preset} plan applies from ${day} to 2026-11-26. The invitation was sent to ${create.firstAdmin.email}.`, `Organisasi dibuat. Slug ${create.slug} tidak dapat diubah.`],
        data: { id: orgs[create.slug].id, slug: create.slug, invitationSent: true, plan: { name: create.preset, validFrom: day, validUntil: '2026-11-26' } },
      }));
    }
    const o = orgs[parts[1]];
    if (!o) return route.fulfill(problem(404, 'not-found', 'Not found'));
    const rest = parts.slice(2);
    if (!rest.length) {
      return send(route, 200, shared.OpsOrganizationDetail.parse({
        id: o.id, slug: o.slug, name: o.name, status: o.status, region: o.region, createdAt: o.createdAt, memberCount: o.memberCount, systemCount: o.systemCount,
        entitlement: o.entitlement ? { plan: o.entitlement.plan, source: o.entitlement.source, maxUsers: o.entitlement.maxUsers, maxManagementSystems: o.entitlement.maxManagementSystems, validUntil: o.entitlement.validUntil } : null,
        domains: o.domains.map((d) => ({ domain: d.domain, status: d.status })), lastSignInAt: o.lastSignInAt,
      }));
    }
    if (rest[0] === 'status') {
      const change = shared.OrganizationStatusChange.parse(body);
      const row = shared.MACHINES['organization.status'].transitions.find((t) => t.from === o.status && t.to === change.status && t.via === 'ops.organizations.status');
      if (!row) {
        return route.fulfill(problem(409, 'transition-not-allowed', 'Transition not allowed', {
          messageKey: 'invalid_status_transition',
          messages: { en: `Organisation ${o.slug} is ${o.status} and cannot move to ${change.status}.`, id: `Organisasi ${o.slug} berstatus ${o.status} dan tidak dapat dipindahkan ke ${change.status}.` },
        }));
      }
      if (row.requires?.includes('confirmSlug') && change.confirmSlug !== o.slug) {
        return route.fulfill(problem(422, 'business-rule', 'Business rule', {
          messageKey: 'confirmation_mismatch',
          messages: { en: `Moving organisation ${o.slug} to ${change.status} needs confirmSlug equal to the slug ${o.slug}.`, id: `Memindahkan organisasi ${o.slug} ke ${change.status} memerlukan confirmSlug yang sama dengan slug ${o.slug}.` },
        }));
      }
      const from = o.status;
      o.status = change.status;
      o.events.unshift({ id: `0000000${o.events.length}-1b2c-4d3e-8f4a-5b6c7d8e9f0a`, from, to: change.status, reason: change.reason, actor: { handle: 'ops', displayName: 'Platform Operator' }, at: at(`0${7 + o.events.length}:00:00`) });
      const ended = change.status === 'suspended' || change.status === 'archived' ? 7 : 0;
      return send(route, 200, shared.OrganizationStatusChangeResult.parse({
        ok: true, changed: [], message: [`Organisation ${o.slug} moved from ${from} to ${change.status}.`, `Organisasi ${o.slug} dipindahkan dari ${from} ke ${change.status}.`],
        data: { slug: o.slug, from, to: change.status, sessionsRevoked: ended, tenantAdmins: 2, tenantAdminsEmailed: 1 },
      }));
    }
    if (rest[0] === 'events') {
      const query = shared.OrganizationEventsQuery.parse(Object.fromEntries(url.searchParams));
      const items = o.events.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((e) => shared.OrganizationStatusEventItem.parse(e));
      return send(route, 200, { items, page: query.page, pageSize: query.pageSize, total: o.events.length });
    }
    if (rest[0] === 'domains' && rest.length === 1 && method === 'GET') return send(route, 200, o.domains.map(domainView));
    if (rest[0] === 'domains' && rest.length === 1 && method === 'POST') {
      const add = shared.OrgDomainAdd.parse(body);
      const domain = add.domain.trim().toLowerCase();
      if (domain === 'gmail.com') {
        return route.fulfill(problem(422, 'business-rule', 'Business rule', {
          messageKey: 'domain_not_allowed',
          messages: { en: 'gmail.com is a free mail domain that anyone can use; only a domain the organisation owns can be verified.', id: 'gmail.com adalah domain email gratis yang dapat dipakai siapa saja; hanya domain milik organisasi yang dapat diverifikasi.' },
        }));
      }
      o.domains.push({ domain, status: 'pending', method: 'dns', requestedAt: at('08:00:00'), verifiedAt: null, lastCheckedAt: null, pendingUntil: '2026-11-04T08:00:00.000Z', txtName: `_mscd-verify.${domain}`, found: false });
      return send(route, 201, shared.OrgDomainAdded.parse({ domain, txtName: `_mscd-verify.${domain}`, txtValue: 'mscd-verify=Q2s9Hc1vE7dYw3pTzR8mNx0LaKfUoBgJ4iSe6VhW5qA', status: 'pending' }));
    }
    if (rest[0] === 'domains' && rest[2] === 'verify') {
      const d = o.domains.find((x) => x.domain === rest[1]);
      verifyCalls += 1;
      if (verifyCalls === 1) return route.fulfill(problem(503, 'dependency-unavailable', 'Dependency unavailable'));
      d.lastCheckedAt = at('09:00:00');
      if (d.status === 'pending') Object.assign(d, { status: 'verified', verifiedAt: at('09:00:00'), pendingUntil: null });
      return send(route, 200, shared.OrgDomainCheck.parse({ ...domainView(d), recordFound: true }));
    }
    if (rest[0] === 'domains' && method === 'DELETE') {
      o.domains = o.domains.filter((x) => x.domain !== rest[1]);
      return route.fulfill({ status: 204 });
    }
    if (rest[0] === 'entitlements' && method === 'GET') {
      if (!o.entitlement) {
        return route.fulfill(problem(404, 'not-found', 'Not found', { messageKey: 'no_entitlement', messages: { en: 'This organisation has no plan yet. Choose a plan preset or set the limits.', id: 'Organisasi ini belum memiliki paket. Pilih preset paket atau tetapkan batasnya.' } }));
      }
      return send(route, 200, shared.Entitlement.parse(view(o)), { etag: serverRow('etag', { row: o.entitlement }) });
    }
    if (rest[0] === 'entitlements' && method === 'PUT') {
      const set = shared.EntitlementSet.parse(body);
      const check = serverRow('ifMatch', { header: request.headers()['if-match'], row: o.entitlement });
      if (check === 'missing') return route.fulfill(problem(428, 'precondition-required', 'Precondition required'));
      if (check === 'stale') return route.fulfill(problem(412, 'precondition-failed', 'Precondition failed'));
      const values = 'preset' in set
        ? { plan: set.preset, source: 'preset', maxUsers: set.preset === 'trial' ? 10 : 50, maxManagementSystems: set.preset === 'trial' ? 1 : 3, validFrom: set.validFrom ?? day, validUntil: set.preset === 'trial' ? '2026-11-26' : '2027-10-27' }
        : { ...set, plan: set.plan ?? null, source: 'manual' };
      o.entitlement = record({ ...o.entitlement, ...values, version: (o.entitlement?.version ?? 0) + 1, updatedAt: new Date(at(`1${o.entitlement?.version ?? 0}:00:00`)) });
      const warnings = o.memberCount > o.entitlement.maxUsers
        ? [{ rule: 'LIC-USERS', messages: { en: `The organisation has ${o.memberCount} active members and the new limit is ${o.entitlement.maxUsers}. Nobody loses access, but no one can be added or invited until the number is below the limit.`, id: `Organisasi ini memiliki ${o.memberCount} anggota aktif dan batas barunya ${o.entitlement.maxUsers}.` } }]
        : [];
      return send(route, 200, shared.EntitlementSetResult.parse({ ok: true, changed: [], data: view(o), ...(warnings.length ? { warnings } : {}) }), { etag: serverRow('etag', { row: o.entitlement }) });
    }
    return route.fulfill(problem(404, 'not-found', 'Not found'));
  });
  return { calls, orgs };
}

test.describe('Operator console organisations against the api @api-only', () => {
  test.use({ apiSession: null });

  test('single tenancy: the organisation routes answer single_tenancy, and the console says that one organisation runs here', async ({ page }) => {
    await signInAsOperator(page);
    for (const path of ['/api/v1/ops/organizations', '/api/v1/ops/organizations/ndt', '/api/v1/ops/organizations/ndt/events', '/api/v1/ops/organizations/ndt/domains', '/api/v1/ops/organizations/ndt/entitlements', '/api/v1/ops/plans']) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(409);
      expect((await response.json()).messageKey, path).toBe('single_tenancy');
    }
    await tab(page, 'Organisations').click();
    const main = page.locator('main');
    await expect(main).toContainText('This installation runs one organisation (single tenancy).');
    await expect(main.locator('select')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Manage' })).toHaveCount(0);
  });

  test('a multi tenancy service: list, create with a plan, status moves, domains and entitlements with If-Match', async ({ page }) => {
    const service = await saasService(page);
    await signInAsOperator(page);
    await tab(page, 'Organisations').click();
    await expect(row(page, 'alpha')).toContainText('41 of 50');
    await expect(row(page, 'alpha')).toContainText('alpha.co.id');
    await expect(row(page, 'beta')).toContainText('Suspended');
    await expect(row(page, 'beta')).toContainText('No plan');
    await page.locator('main select').selectOption('suspended');
    await expect(page.locator('main tbody tr')).toHaveCount(1);
    expect(service.calls.some((c) => c.method === 'GET' && c.query.status === 'suspended')).toBe(true);
    await page.locator('main select').selectOption('');

    // Create organisation with the first preset (no one-time link: the answer carries none).
    await ui.pageAction(page, 'Create organisation').click();
    const dialog = ui.modal(page);
    const inputs = dialog.locator('input');
    await expect(dialog.locator('select').nth(1)).toHaveValue('trial');
    await inputs.nth(0).fill('gamma');
    await inputs.nth(1).fill('PT Gamma Medika');
    await inputs.nth(3).fill('it@gammamedika.co.id');
    await inputs.nth(4).fill('Dewi Lestari');
    await dialog.locator('button', { hasText: /^Create$/ }).click();
    await expect(dialog).toContainText('The trial plan applies from 2026-10-28 to 2026-11-26.');
    await expect(dialog.locator('button', { hasText: 'Copy link' })).toHaveCount(0);
    expect(service.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/ops/organizations').body).toMatchObject({ slug: 'gamma', preset: 'trial' });
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(row(page, 'gamma')).toContainText('0 of 10');

    // Status: the server's 422 message for a wrong slug, then the move with the ended sessions and the emails.
    await row(page, 'alpha').getByRole('button', { name: 'Manage' }).click();
    const drawer = ui.drawer(page);
    await expect(drawer).toContainText('PT Alpha Konsultan');
    await expectOverlayReadable(page);
    await drawerTab(page, 'Status').click();
    await drawer.getByRole('button', { name: 'Suspend' }).click();
    await dialog.locator('textarea').fill('Invoice of October unpaid');
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(drawer).toContainText('Sessions ended: 7.');
    await expect(drawer).toContainText('Tenant Admins emailed: 1 of 2.');
    await expect(drawer).toContainText('Some emails did not go out. Tell the Tenant Admins yourself.');
    await drawer.getByRole('button', { name: 'Start offboarding' }).click();
    await dialog.locator('textarea').fill('Contract ended');
    await dialog.locator('input').fill('alpha');
    // The console checks the slug before sending; the server checks it again (422 confirmation_mismatch).
    await page.route(/\/status$/, async (route) => {
      const body = JSON.parse(route.request().postData());
      await route.fallback({ postData: JSON.stringify({ ...body, confirmSlug: 'alfa' }) });
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('Moving organisation alpha to offboarding needs confirmSlug equal to the slug alpha.');
    await dialog.getByRole('button', { name: 'Start offboarding' }).click();
    await expect(dialog).toHaveCount(0);
    const moves = service.calls.filter((c) => c.path.endsWith('/status')).map((c) => c.body);
    expect(moves).toEqual([
      { status: 'suspended', reason: 'Invoice of October unpaid' },
      { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'alfa' },
      { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'alpha' },
    ]);
    await drawerTab(page, 'History').click();
    await expect(drawer.locator('tbody tr')).toHaveCount(2);
    await expect(drawer.locator('tbody tr').first()).toContainText('Contract ended');

    // Domains: the record once, a DNS that does not answer, then the record found; removal.
    await drawerTab(page, 'Domains').click();
    await drawer.getByRole('button', { name: 'Add domain' }).click();
    await dialog.locator('input').fill('gmail.com');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText('gmail.com is a free mail domain that anyone can use');
    await dialog.locator('input').fill('alpha-group.co.id');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toContainText('mscd-verify=Q2s9Hc1vE7dYw3pTzR8mNx0LaKfUoBgJ4iSe6VhW5qA');
    await expectOverlayReadable(page);
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(await page.content()).not.toContain('Q2s9Hc1vE7dYw3pTzR8mNx0LaKfUoBgJ4iSe6VhW5qA');
    const added = drawer.locator('[data-domain="alpha-group.co.id"]');
    await added.getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText('DNS did not answer, so nothing changed.');
    await added.getByRole('button', { name: 'Verify now' }).click();
    await expect(drawer.locator('[data-domain-outcome]')).toContainText('The record of alpha-group.co.id was found. The domain is verified.');
    await added.getByRole('button', { name: 'Remove' }).click();
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Domain alpha-group.co.id removed');
    expect(service.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/ops/organizations/alpha/domains/alpha-group.co.id')).toBe(true);

    // Entitlements: If-Match is the server's ETag; a stale one gets the conflict and the latest values; the warning.
    await drawerTab(page, 'Entitlements').click();
    const form = drawer.locator('[data-entitlement-form]');
    await expect(drawer.locator('[data-entitlement-version="3"]')).toContainText('41 of 50');
    const meanwhile = service.orgs.alpha.entitlement;
    service.orgs.alpha.entitlement = { ...meanwhile, maxUsers: 60, version: 4, updatedAt: new Date('2026-10-28T11:30:00.000Z') };
    await form.getByLabel('Users').fill('30');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(form).toContainText('Someone changed this entitlement after you opened it.');
    await expect(drawer.locator('[data-entitlement-version="4"]')).toContainText('41 of 60');
    await expect(form.getByLabel('Users')).toHaveValue('60');
    await form.getByLabel('Users').fill('30');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer).toContainText('The organisation has 41 active members and the new limit is 30.');
    await expect(drawer.locator('[data-entitlement-version="5"]')).toContainText('41 of 30');
    const puts = service.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => serverRow('ifMatch', { header: c.headers['if-match'], row: { version: 4, updatedAt: '2026-10-28T11:30:00.000Z' } }))).toEqual(['stale', 'ok']);
    expect(puts[0].headers['if-match']).toBe(serverRow('etag', { row: { version: 3, updatedAt: '2026-10-28T03:00:00.000Z' } }));
    await expectOverlayReadable(page);
    await page.keyboard.press('Escape');

    // An organisation without a plan: If-Match * and the first preset.
    await row(page, 'beta').getByRole('button', { name: 'Manage' }).click();
    await drawerTab(page, 'Entitlements').click();
    await expect(drawer).toContainText('No plan yet');
    await expect(form.locator('select')).toHaveValue('trial');
    await form.getByRole('button', { name: 'Save the entitlement' }).click();
    await expect(drawer.locator('[data-entitlement-version="1"]')).toContainText('3 of 10');
    expect(service.calls.filter((c) => c.method === 'PUT').at(-1)).toMatchObject({ path: '/api/v1/ops/organizations/beta/entitlements', body: { preset: 'trial' } });
    expect(service.calls.filter((c) => c.method === 'PUT').at(-1).headers['if-match']).toBe('*');
    await page.keyboard.press('Escape');
    await expect(row(page, 'beta')).toContainText('trial');
    // Every write carried the session's CSRF token.
    for (const c of service.calls.filter((x) => x.method !== 'GET')) expect(c.headers['x-csrf-token'], `${c.method} ${c.path}`).toBeTruthy();
  });

  for (const theme of ['light', 'dark']) {
    test(`every tab and dialog of the drawer is readable, ${theme} theme`, async ({ page }) => {
      await saasService(page);
      await signInAsOperator(page);
      if (theme === 'dark') {
        await page.locator('header button[title="Theme"]').click();
        await expect(page.locator('.mscd').first()).toHaveAttribute('data-theme', 'dark');
      }
      await tab(page, 'Organisations').click();
      await row(page, 'alpha').getByRole('button', { name: 'Manage' }).click();
      const drawer = ui.drawer(page);
      const dialog = ui.modal(page);
      for (const label of ['Overview', 'Status', 'Domains', 'Entitlements', 'History']) {
        await drawerTab(page, label).click();
        await expect(drawer.locator('[role="tabpanel"]')).not.toContainText('Loading');
        await expectOverlayReadable(page);
      }
      await drawerTab(page, 'Status').click();
      await drawer.getByRole('button', { name: 'Start offboarding' }).click();
      await expectOverlayReadable(page);
      await page.keyboard.press('Escape');
      await drawerTab(page, 'Domains').click();
      await drawer.getByRole('button', { name: 'Add domain' }).click();
      await expectOverlayReadable(page);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await drawer.locator('[data-domain="alpha.co.id"]').getByRole('button', { name: 'Remove' }).click();
      await expectOverlayReadable(page);
    });
  }

  test('an operator who may only read sees the organisation without any action', async ({ page }) => {
    await saasService(page, { rights: ['ops.read', 'license.manage', 'pack.install'] });
    await signInAsOperator(page);
    await tab(page, 'Organisations').click();
    await expect(ui.pageAction(page, 'Create organisation')).toHaveCount(0);
    await row(page, 'alpha').getByRole('button', { name: 'Manage' }).click();
    const drawer = ui.drawer(page);
    await drawerTab(page, 'Status').click();
    await expect(drawer).toContainText('You can view this organisation. Changing it needs the operator right to manage organisations.');
    await expect(drawer.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
    await drawerTab(page, 'Domains').click();
    await expect(drawer.locator('[data-domain="alpha.co.id"]')).toContainText('Verified');
    await expect(drawer.getByRole('button', { name: 'Add domain' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await drawerTab(page, 'Entitlements').click();
    await expect(drawer).toContainText('Changing the entitlement needs the operator right to manage entitlements.');
    await expect(drawer.locator('[data-entitlement-form]')).toHaveCount(0);
  });
});
