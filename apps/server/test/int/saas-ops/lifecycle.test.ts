// The organisation lifecycle of the platform operator (Milestone 2 D.1, J.4, J.8, K.6; M2-S09) in multi tenancy:
// every move of the status machine with its status event, platform-chain audit entry and email to the Tenant Admins;
// every refused move (409 `transition-not-allowed`, messageKey `invalid_status_transition`); the slug confirmation of
// offboarding and archived (422 `confirmation_mismatch`); the sessions of a suspended or archived organisation ended
// while the other organisations' sessions keep working; the organisation detail and its status history; the region and
// plan preset of a new organisation; onboarding refused when mail is required and missing; and 409 `single_tenancy` for
// each new route in single tenancy.
import {
  OpsOrganizationDetail,
  OrganizationStatusChangeResult,
  type OpsOrganizationCreateResult,
  type OpsOrganizationItem,
  type OrganizationStatus,
  type OrganizationStatusEventItem,
  type Page,
} from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, createFullApp, type FullApp } from '../contract/harness';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, createOnboardingApp, inPlatform, inTenant, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import {
  CREATE, EVENTS, GET, LIST, MULTI, PLANS, STATUS, eventsOf, forceStatus, movedSession, problemType, sessionStates, setStatus, statusAudit, statusOf,
} from './helpers';

const ALL: readonly OrganizationStatus[] = ['active', 'suspended', 'offboarding', 'archived'];
const ALLOWED: Readonly<Record<OrganizationStatus, readonly OrganizationStatus[]>> = {
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['active', 'archived'],
  archived: [],
  // Milestone 3 J.7 (M3-01): the purge sets deleted; the operator's route never reaches or leaves it.
  deleted: [],
};

describe('organisation lifecycle of the platform operator (Milestone 2 J.8, M2-S09)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let operator: Person;
  let op: Client;

  beforeAll(async () => {
    mail = await startMailpit();
    operator = await addPerson(db, 'ops.lifecycle', [], { platformOperator: true, password: true });
    full = await createOnboardingApp(db, { mail, env: { ...MULTI, ...PLANS } });
    op = await sessionIn(full, operator.id, null);
  });
  afterAll(async () => {
    await full?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  describe('POST /ops/organizations/{org}/status', () => {
    let alpha: CreatedTenant;
    let admins: Person[];

    beforeAll(async () => {
      alpha = await createTenant(db, 'alpha', { name: 'PT Alpha Sejahtera' });
      admins = [
        await addPerson(db, 'alpha.admin1', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true }),
        await addPerson(db, 'alpha.admin2', [{ org: alpha, adminRoles: ['tenant_admin'] }], { password: true }),
      ];
    });

    it('moves an organisation through every allowed status with the event, the audit entry and the email', async () => {
      const steps: { to: OrganizationStatus; confirm?: boolean }[] = [
        { to: 'suspended' },
        { to: 'active' },
        { to: 'offboarding', confirm: true },
        { to: 'active' },
        { to: 'suspended' },
        { to: 'offboarding', confirm: true },
        { to: 'archived', confirm: true },
      ];
      let from: OrganizationStatus = 'active';
      for (const [index, step] of steps.entries()) {
        const reason = `Step ${index + 1}: contract review`;
        const call = await setStatus(op, 'alpha', { status: step.to, reason, ...(step.confirm ? { confirmSlug: 'alpha' } : {}) });
        expect(call.violations).toEqual([]);
        expect(call.status, call.text).toBe(200);
        expect(OrganizationStatusChangeResult.safeParse(call.body).success).toBe(true);
        expect(call.body.data).toEqual({ slug: 'alpha', from, to: step.to, sessionsRevoked: 0, tenantAdmins: 2, tenantAdminsEmailed: 2 });
        expect(call.body.message?.[0]).toContain(`moved from ${from} to ${step.to}`);
        expect(await statusOf(db, alpha.id)).toBe(step.to);
        from = step.to;
      }

      // One status event per move, with the reason and the operator.
      const events = await eventsOf(db, alpha.id);
      expect(events.map((e) => [e.from_status, e.to_status])).toEqual([
        ['active', 'suspended'],
        ['suspended', 'active'],
        ['active', 'offboarding'],
        ['offboarding', 'active'],
        ['active', 'suspended'],
        ['suspended', 'offboarding'],
        ['offboarding', 'archived'],
      ]);
      expect(events.every((e) => e.actor_user_id === operator.id)).toBe(true);
      expect(events[0]!.reason).toBe('Step 1: contract review');

      // One platform-chain audit entry per move, with the old and the new status.
      const audit = await statusAudit(db, alpha.id);
      expect(audit).toHaveLength(7);
      expect(audit[0]).toMatchObject({
        actor_kind: 'operator',
        actor_user_id: operator.id,
        entity_type: 'organization',
        entity_id: alpha.id,
        entity_code: 'alpha',
        before_data: { status: 'active' },
        after_data: { status: 'suspended', reason: 'Step 1: contract review', eventId: events[0]!.id, sessionsRevoked: 0, tenantAdmins: 2 },
      });

      // Each Tenant Admin got one email per move.
      for (const admin of admins) {
        await mail.waitFor(admin.email, (m) => m.subject.includes('is closed on MSCD'));
        const statusMails = (await mail.messages(admin.email)).filter((m) => m.mailKind === 'account:organization_status_changed');
        expect(statusMails).toHaveLength(7);
      }

      // The history route, newest first, and its paging.
      const history = await callRoute<Page<OrganizationStatusEventItem>>(op, EVENTS, { params: { org: 'alpha' } });
      expect(history.violations).toEqual([]);
      expect(history.status).toBe(200);
      expect(history.body.total).toBe(7);
      expect(history.body.items.map((e) => `${e.from}>${e.to}`)).toEqual([
        'offboarding>archived', 'suspended>offboarding', 'active>suspended', 'offboarding>active', 'active>offboarding', 'suspended>active', 'active>suspended',
      ]);
      expect(history.body.items[0]).toEqual({
        id: events[6]!.id,
        from: 'offboarding',
        to: 'archived',
        reason: 'Step 7: contract review',
        actor: { handle: operator.handle, displayName: operator.displayName },
        at: expect.any(String),
      });
      const second = await callRoute<Page<OrganizationStatusEventItem>>(op, EVENTS, { params: { org: 'alpha' }, query: { page: '2', pageSize: '3' } });
      expect(second.violations).toEqual([]);
      expect(second.body).toMatchObject({ page: 2, pageSize: 3, total: 7 });
      expect(second.body.items.map((e) => `${e.from}>${e.to}`)).toEqual(['offboarding>active', 'active>offboarding', 'suspended>active']);
    });

    it('refuses every move the machine does not allow with 409 invalid_status_transition and changes nothing', async () => {
      const orgs: Partial<Record<OrganizationStatus, CreatedTenant>> = {};
      for (const status of ALL) {
        const org = await createTenant(db, `r_${status}`, { name: `Refusals ${status}` });
        if (status !== 'active') await forceStatus(db, org.id, status);
        orgs[status] = org;
      }
      for (const from of ALL) {
        const org = orgs[from]!;
        for (const to of ALL.filter((t) => !ALLOWED[from].includes(t))) {
          const call = await setStatus(op, org.slug, { status: to, reason: 'Refused move', confirmSlug: org.slug });
          expect(call.violations, `${from} to ${to}`).toEqual([]);
          expect(call.status, `${from} to ${to}`).toBe(409);
          expect(call.body).toMatchObject({ type: problemType('transition-not-allowed'), messageKey: 'invalid_status_transition' });
          expect(call.body.messages.en).toContain(org.slug);
        }
        expect(await statusOf(db, org.id)).toBe(from);
        expect(await eventsOf(db, org.id)).toEqual([]);
        expect(await statusAudit(db, org.id)).toEqual([]);
      }
      // The message names the moves that are allowed, or says that archived is final.
      const fromSuspended = await setStatus(op, 'r_suspended', { status: 'archived', reason: 'Refused move', confirmSlug: 'r_suspended' });
      expect(fromSuspended.body.messages.en).toContain('From suspended it can move to active or offboarding.');
      const fromArchived = await setStatus(op, 'r_archived', { status: 'active', reason: 'Refused move' });
      expect(fromArchived.body.messages.en).toContain('archived is final.');
    });

    it('needs confirmSlug equal to the slug for offboarding and archived (422 confirmation_mismatch)', async () => {
      const org = await createTenant(db, 'confirm_org', { name: 'Confirm' });
      for (const confirmSlug of [undefined, 'other_org']) {
        const call = await setStatus(op, 'confirm_org', { status: 'offboarding', reason: 'Contract ended', ...(confirmSlug ? { confirmSlug } : {}) });
        expect(call.violations).toEqual([]);
        expect(call.status).toBe(422);
        expect(call.body).toMatchObject({ type: problemType('business-rule'), messageKey: 'confirmation_mismatch' });
      }
      expect(await statusOf(db, org.id)).toBe('active');
      // A suspension needs no confirmation; offboarding with it, then archived without it.
      expect((await setStatus(op, 'confirm_org', { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'confirm_org' })).status).toBe(200);
      const archived = await setStatus(op, 'confirm_org', { status: 'archived', reason: 'Read-only period over' });
      expect(archived.status).toBe(422);
      expect(archived.body.messageKey).toBe('confirmation_mismatch');
      expect(await statusOf(db, org.id)).toBe('offboarding');
      expect(await eventsOf(db, org.id)).toHaveLength(1);
      // The reason is required and checked by the schema.
      const short = await callRoute(op, STATUS, { params: { org: 'confirm_org' }, body: { status: 'active', reason: 'x' } });
      expect(short.status).toBe(400);
      const missing = await callRoute(op, STATUS, { params: { org: 'confirm_org' }, body: { status: 'active' } });
      expect(missing.status).toBe(400);
    });

    it('answers 404 for an unknown organisation and 403 to anyone but the platform operator', async () => {
      const unknown = await setStatus(op, 'nobody_here', { status: 'suspended', reason: 'Unknown' });
      expect(unknown.violations).toEqual([]);
      expect(unknown.status).toBe(404);
      expect((await callRoute(op, GET, { params: { org: 'nobody_here' } })).status).toBe(404);
      expect((await callRoute(op, EVENTS, { params: { org: 'nobody_here' } })).status).toBe(404);

      const org = await createTenant(db, 'guarded', { name: 'Guarded' });
      const admin = await addPerson(db, 'guarded.admin', [{ org, adminRoles: ['tenant_admin'] }], { password: true });
      const ta = await sessionIn(full, admin.id, org);
      expect((await ta.post('/api/v1/ops/organizations/guarded/status', { status: 'suspended', reason: 'Not mine' })).status).toBe(403);
      expect((await ta.get('/api/v1/ops/organizations/guarded')).status).toBe(403);
      expect((await ta.get('/api/v1/ops/organizations/guarded/events')).status).toBe(403);
      expect(await statusOf(db, org.id)).toBe('active');
    });
  });

  describe('sessions of a suspended or archived organisation', () => {
    it('ends the sessions whose current organisation it is, and the other organisations keep working', async () => {
      const beta = await createTenant(db, 'beta', { name: 'PT Beta' });
      const home = await createTenant(db, 'home_two', { name: 'PT Home Two' });
      const betaAdmin = await addPerson(db, 'beta.admin', [{ org: beta, adminRoles: ['tenant_admin'] }], { password: true });
      const dual = await addPerson(db, 'dual.member', [{ org: beta }, { org: home, isDefault: false }], { password: true });
      const homeOnly = await addPerson(db, 'home.only', [{ org: home }], { password: true });

      const adminInBeta = await sessionIn(full, betaAdmin.id, beta);
      const dualInBeta = await sessionIn(full, dual.id, beta);
      const dualInHome = await sessionIn(full, dual.id, home);
      // Opened through beta's sign-in policy, then moved to home: its current organisation is home.
      const dualMoved = await movedSession(full, dual.id, beta, home);
      const homeSession = await sessionIn(full, homeOnly.id, home);
      for (const client of [adminInBeta, dualInBeta, dualInHome, dualMoved, homeSession]) expect((await client.get('/api/v1/me')).status).toBe(200);
      expect((await adminInBeta.get('/api/v1/admin/organization')).status).toBe(200);

      const call = await setStatus(op, 'beta', { status: 'suspended', reason: 'Invoice overdue by 60 days' });
      expect(call.status, call.text).toBe(200);
      expect(call.body.data).toMatchObject({ from: 'active', to: 'suspended', sessionsRevoked: 2, tenantAdmins: 1 });

      expect((await adminInBeta.get('/api/v1/me')).status).toBe(401);
      expect((await dualInBeta.get('/api/v1/me')).status).toBe(401);
      for (const client of [dualInHome, dualMoved, homeSession]) expect((await client.get('/api/v1/me')).status).toBe(200);
      expect((await dualInHome.get('/api/v1/notifications')).status).toBe(200);
      expect(await sessionStates(db, dual.id)).toEqual([
        { organization_id: beta.id, revoke_reason: 'organisation_suspended' },
        { organization_id: home.id, revoke_reason: null },
        { organization_id: home.id, revoke_reason: null },
      ]);
      // The people keep every membership.
      const memberships = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select(['organization_id', 'status', 'deleted_at']).where('user_id', '=', dual.id).orderBy('is_default', 'desc').execute(),
      );
      expect(memberships).toEqual([
        { organization_id: beta.id, status: 'active', deleted_at: null },
        { organization_id: home.id, status: 'active', deleted_at: null },
      ]);

      // A new session in the suspended organisation is refused on business routes; active again, it works.
      const late = await sessionIn(full, betaAdmin.id, beta);
      const refused = await late.get('/api/v1/admin/organization');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ type: problemType('organisation-inactive') });
      expect((await setStatus(op, 'beta', { status: 'active', reason: 'Invoice paid' })).body.data).toMatchObject({ sessionsRevoked: 0 });
      expect((await late.get('/api/v1/admin/organization')).status).toBe(200);

      // Offboarding keeps the sessions (read-only); archived ends them.
      const offboarding = await setStatus(op, 'beta', { status: 'offboarding', reason: 'Contract ended', confirmSlug: 'beta' });
      expect(offboarding.body.data).toMatchObject({ sessionsRevoked: 0 });
      expect((await late.get('/api/v1/admin/organization')).status).toBe(200);
      const write = await late.patch('/api/v1/admin/organization', { siteCount: 4 }, { 'if-match': '*' });
      expect(write.status).toBe(403);
      const archived = await setStatus(op, 'beta', { status: 'archived', reason: 'Read-only period over', confirmSlug: 'beta' });
      expect(archived.body.data).toMatchObject({ sessionsRevoked: 1 });
      expect((await late.get('/api/v1/me')).status).toBe(401);
      expect(await sessionStates(db, betaAdmin.id)).toEqual([
        { organization_id: beta.id, revoke_reason: 'organisation_suspended' },
        { organization_id: beta.id, revoke_reason: 'organisation_archived' },
      ]);
      expect((await dualInHome.get('/api/v1/me')).status).toBe(200);
    });
  });

  describe('the notice to the Tenant Admins (J.4)', () => {
    it('emails every active Tenant Admin in their language, writes the in-app notice and names no person', async () => {
      const delta = await createTenant(db, 'delta', { name: 'PT Delta Makmur' });
      const first = await addPerson(db, 'delta.admin', [{ org: delta, adminRoles: ['tenant_admin'] }], { password: true });
      const second = await addPerson(db, 'delta.admin.id', [{ org: delta, adminRoles: ['tenant_admin'] }], { password: true });
      const member = await addPerson(db, 'delta.member', [{ org: delta }], { password: true });
      const disabled = await addPerson(db, 'delta.gone', [{ org: delta, adminRoles: ['tenant_admin'] }], { password: true, status: 'disabled' });
      await inPlatform(db, (trx) => trx.insertInto('platform.user_preference').values({ user_id: second.id, key: 'lang', value: JSON.stringify('id') }).execute());

      const call = await setStatus(op, 'delta', { status: 'suspended', reason: 'Invoice overdue by 60 days' });
      expect(call.status, call.text).toBe(200);
      expect(call.body.data).toMatchObject({ tenantAdmins: 2, tenantAdminsEmailed: 2 });
      expect(call.body.message?.[0]).toContain('2 of 2 Tenant Admins were emailed');

      const english = await mail.waitFor(first.email, (m) => m.mailKind === 'account:organization_status_changed');
      expect(english.subject).toBe('[MSCD] PT Delta Makmur is suspended on MSCD');
      expect(english.text).toContain('Your MSCD service provider changed the status of PT Delta Makmur to suspended.');
      expect(english.text).toContain('Members cannot open the data of the organisation');
      expect(english.text).toContain('Reason given: Invoice overdue by 60 days');
      const indonesian = await mail.waitFor(second.email, (m) => m.mailKind === 'account:organization_status_changed');
      expect(indonesian.subject).toBe('[MSCD] PT Delta Makmur ditangguhkan di MSCD');
      expect(indonesian.text).toContain('Alasan yang diberikan: Invoice overdue by 60 days');
      for (const message of [english, indonesian]) {
        for (const personal of [operator.email, operator.handle, operator.displayName, first.displayName, second.displayName, member.email]) {
          expect(message.text).not.toContain(personal);
        }
      }
      expect((await mail.messages(member.email)).filter((m) => m.mailKind === 'account:organization_status_changed')).toEqual([]);
      expect((await mail.messages(disabled.email)).filter((m) => m.mailKind === 'account:organization_status_changed')).toEqual([]);

      const notices = await inTenant(db, delta, (trx) =>
        trx.selectFrom('notification').select(['recipient_user_id', 'kind', 'title_en', 'title_id', 'body_en', 'email_status']).orderBy('title_id').execute(),
      );
      expect(notices.map((n) => n.recipient_user_id).sort()).toEqual([first.id, second.id].sort());
      expect(notices[0]).toMatchObject({
        kind: 'organization_status_changed',
        title_en: 'PT Delta Makmur is suspended on MSCD',
        title_id: 'PT Delta Makmur ditangguhkan di MSCD',
        email_status: 'skipped',
      });
      expect(notices[0]!.body_en).toContain('Invoice overdue by 60 days');
    });

    it('counts the emails that could not be sent and still changes the status', async () => {
      const quiet = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
      try {
        const opQuiet = await sessionIn(quiet, operator.id, null);
        const org = await createTenant(db, 'no_mail', { name: 'No Mail' });
        await addPerson(db, 'no_mail.admin', [{ org, adminRoles: ['tenant_admin'] }], { password: true });
        const call = await setStatus(opQuiet, 'no_mail', { status: 'suspended', reason: 'Mail is down here' });
        expect(call.status, call.text).toBe(200);
        expect(call.body.data).toMatchObject({ tenantAdmins: 1, tenantAdminsEmailed: 0 });
        expect(await statusOf(db, org.id)).toBe('suspended');
      } finally {
        await quiet.close();
      }
    });
  });

  describe('GET /ops/organizations/{org} and new organisations', () => {
    it('creates an organisation in the default region with its plan preset, and shows its detail', async () => {
      const created = await callRoute<OpsOrganizationCreateResult>(op, CREATE, {
        body: { slug: 'epsilon', name: 'PT Epsilon', timeZone: 'Asia/Makassar', siteCount: 2, firstAdmin: { email: 'admin@epsilon.test', displayName: 'Admin Epsilon' }, preset: 'trial' },
      });
      expect(created.violations).toEqual([]);
      expect(created.status, created.text).toBe(201);
      expect(created.body.data).toEqual({
        id: expect.any(String),
        slug: 'epsilon',
        invitationSent: true,
        plan: { name: 'trial', validFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), validUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      });
      expect(created.body.message?.[0]).toContain('The trial plan applies from');
      const id = created.body.data.id;
      const row = await inPlatform(db, (trx) => trx.selectFrom('platform.organization').select(['region', 'local_login', 'status']).where('id', '=', id).executeTakeFirstOrThrow());
      expect(row).toEqual({ region: 'id', local_login: 'allowed', status: 'active' });
      const entitlement = await inPlatform(db, (trx) => trx.selectFrom('platform.entitlement').select(['plan', 'source', 'max_users', 'max_management_systems']).where('organization_id', '=', id).executeTakeFirst());
      expect(entitlement).toEqual({ plan: 'trial', source: 'preset', max_users: 3, max_management_systems: 1 });
      const createdAudit = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.audit_log').select(['after_data']).where('action', '=', 'ops.organization_created').where('organization_id', '=', id).executeTakeFirstOrThrow(),
      );
      expect(createdAudit.after_data).toMatchObject({ region: 'id', preset: 'trial', plan: { name: 'trial', version: 1 } });
      // The invitation counts against the plan: the first administrator is invited.
      await mail.waitFor('admin@epsilon.test', (m) => m.mailKind === 'account:invitation');

      // An active member who signed in, and two email domains.
      const epsilon = { id, slug: 'epsilon', schemaName: 'org_epsilon' } as CreatedTenant;
      const member = await addPerson(db, 'epsilon.member', [{ org: epsilon }], { password: true });
      await sessionIn(full, member.id, epsilon);
      await inPlatform(db, async (trx) => {
        await trx.insertInto('platform.verified_domain').values({ organization_id: id, domain: 'epsilon.co.id', verified_by: 'test', verified_at: new Date() }).execute();
        await trx
          .insertInto('platform.verified_domain')
          .values({ organization_id: id, domain: 'epsilon.id', status: 'pending', method: 'dns', txt_token_hash: Buffer.alloc(32, 1), requested_at: new Date(), verified_by: null, verified_at: null })
          .execute();
      });

      const detail = await callRoute<OpsOrganizationDetail>(op, GET, { params: { org: 'epsilon' } });
      expect(detail.violations).toEqual([]);
      expect(detail.status).toBe(200);
      expect(OpsOrganizationDetail.safeParse(detail.body).success).toBe(true);
      expect(detail.body).toEqual({
        id,
        slug: 'epsilon',
        name: 'PT Epsilon',
        status: 'active',
        region: 'id',
        createdAt: expect.any(String),
        memberCount: 1,
        systemCount: 0,
        entitlement: { plan: 'trial', source: 'preset', maxUsers: 3, maxManagementSystems: 1, validUntil: created.body.data.plan!.validUntil },
        domains: [
          { domain: 'epsilon.co.id', status: 'verified' },
          { domain: 'epsilon.id', status: 'pending' },
        ],
        lastSignInAt: expect.any(String),
        offboardingEndsAt: null,
        deletion: null,
        lastExport: null,
      });
      expect(Date.now() - Date.parse(detail.body.lastSignInAt!)).toBeLessThan(120_000);

      // The list shows the plan, its end and the verified domains only.
      const listed = await callRoute<Page<OpsOrganizationItem>>(op, LIST, { query: { q: 'epsilon' } });
      expect(listed.violations).toEqual([]);
      expect(listed.body.items[0]).toMatchObject({ slug: 'epsilon', status: 'active', plan: 'trial', validUntil: created.body.data.plan!.validUntil, verifiedDomains: ['epsilon.co.id'] });
    });

    it('shows an organisation without a plan, sign-in or domains', async () => {
      await createTenant(db, 'zeta', { name: 'PT Zeta' });
      const detail = await callRoute<OpsOrganizationDetail>(op, GET, { params: { org: 'zeta' } });
      expect(detail.violations).toEqual([]);
      expect(detail.body).toMatchObject({ slug: 'zeta', region: null, memberCount: 0, systemCount: 0, entitlement: null, domains: [], lastSignInAt: null });
      const history = await callRoute<Page<OrganizationStatusEventItem>>(op, EVENTS, { params: { org: 'zeta' } });
      expect(history.body).toEqual({ items: [], page: 1, pageSize: 200, total: 0 });
    });

    it('refuses to onboard an organisation when mail is required and does not work (409 mail_required)', async () => {
      const strict = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS, MSCD__MAIL__REQUIRED: 'true' } });
      try {
        const opStrict = await sessionIn(strict, operator.id, null);
        const call = await callRoute(opStrict, CREATE, {
          body: { slug: 'no_mail_org', name: 'No Mail Org', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'admin@nomail.test', displayName: 'Admin' }, preset: 'trial' },
        });
        expect(call.violations).toEqual([]);
        expect(call.status).toBe(409);
        expect(call.body).toMatchObject({ type: problemType('conflict'), messageKey: 'mail_required' });
        expect(call.text).not.toContain('/invite');
        const row = await inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('id').where('slug', '=', 'no_mail_org').executeTakeFirst());
        expect(row).toBeUndefined();
      } finally {
        await strict.close();
      }
    });
  });

  describe('single tenancy', () => {
    it('answers 409 single_tenancy on each new route', async () => {
      const single = await createFullApp(db);
      try {
        const opSingle = await sessionIn(single, operator.id, null);
        const org = await createTenant(db, 'only_one', { name: 'Only One' });
        for (const [def, input] of [
          [GET, { params: { org: 'only_one' } }],
          [STATUS, { params: { org: 'only_one' }, body: { status: 'suspended', reason: 'Single tenancy' } }],
          [EVENTS, { params: { org: 'only_one' } }],
        ] as const) {
          const call = await callRoute(opSingle, def, input);
          expect(call.violations, def.id).toEqual([]);
          expect(call.status, def.id).toBe(409);
          expect(call.body, def.id).toMatchObject({ type: problemType('conflict'), messageKey: 'single_tenancy' });
        }
        expect(await statusOf(db, org.id)).toBe('active');
      } finally {
        await single.close();
      }
    });
  });
});
