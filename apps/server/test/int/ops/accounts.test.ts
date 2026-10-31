// The accounts of the service for the platform operator (Milestone 2 section L, M2-19): the list with search, filters
// and paging and nothing secret in it; the detail with the open sessions (network cut to /24 and /48, browser and
// system) and the audit entries; and each action with its reason, its one platform audit entry and its refusals:
// the second-factor reset (never the operator's own; `emailed` says whether its email went out), the password link
// (used end to end, the older link ended, the mail rule), the invitation sent again (older link revoked, new one
// accepted), ending the sessions, and disabling and enabling an account (If-Match, own account, invited account either
// way, system account, last active operator, and two disables that decide about the last operator at the same time).
import { OpsAccountDetail, type OpsAccountActionResult, type OpsAccountItem, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID, type Principal } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { OpsAccountsService } from '../../../src/modules/ops/accounts.service';
import { browserOf } from '../../../src/modules/ops/account-support';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { anonymous, type FullApp } from '../contract/harness';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { PASSWORD, addPerson, createOnboardingApp, grantRole, inPlatform, inTenant, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import {
  ACCOUNT, ACCOUNTS, PASSWORD_RESET, RESEND, RESET_MFA, REVOKE, STATUS, addFactor, auditAbout, call, sessionsOf, stampSessions,
} from './accounts-helpers';

const REASON = 'Asked by the Tenant Admin in ticket 4411';
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('browser and system of a session (Milestone 2 M2-19)', () => {
  it('names the browser with its major version and the system, never the whole user agent', () => {
    expect(browserOf(CHROME_WINDOWS)).toBe('Chrome 130, Windows');
    expect(browserOf(SAFARI_IPHONE)).toBe('Safari 17, iOS');
    expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox 131, Linux');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.79')).toBe('Edge 129, Windows');
    expect(browserOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Chrome 130, Android');
    expect(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('Safari 17, macOS');
    expect(browserOf('curl/8.5.0')).toBeNull();
    expect(browserOf(null)).toBeNull();
  });
});

describe('accounts of the service for the platform operator (Milestone 2 M2-19)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let operator: Person;
  let op: Client;
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let rina: Person;
  let sari: Person;
  let dewi: Person;

  beforeAll(async () => {
    mail = await startMailpit();
    alpha = await createTenant(db, 'alpha', { name: 'PT Alpha Sejahtera' });
    beta = await createTenant(db, 'beta', { name: 'PT Beta Mandiri' });
    operator = await addPerson(db, 'ops.accounts', [], { platformOperator: true, password: true });
    rina = await addPerson(db, 'rina.acc', [{ org: alpha, adminRoles: ['tenant_admin'] }, { org: beta }], { password: true });
    sari = await addPerson(db, 'sari.acc', [{ org: alpha, status: 'invited', invitedBy: rina.id }], { status: 'invited' });
    dewi = await addPerson(db, 'dewi.acc', [{ org: beta }], { password: true });
    full = await createOnboardingApp(db, { mail });
    op = await sessionIn(full, operator.id, null);
  });
  afterAll(async () => {
    await full?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  describe('GET /ops/accounts', () => {
    it('lists every account with its memberships and admin roles, and nothing secret or of the customer roles', async () => {
      const msId = await inTenant(db, alpha, async (trx) => {
        const row = await sql<{ id: string }>`select id from management_system limit 1`.execute(trx);
        return row.rows[0]?.id ?? null;
      });
      if (msId) await grantRole(db, alpha, msId, rina.id, 'ms_manager');
      await addFactor(db, dewi.id);
      const reply = await call<Page<OpsAccountItem>>(op, ACCOUNTS, { query: { pageSize: 200 } });
      expect(reply.status).toBe(200);
      const byHandle = new Map(reply.body.items.map((a) => [a.handle, a]));
      expect(byHandle.get('system')).toMatchObject({ kind: 'system', id: SYSTEM_USER_ID, memberships: [] });
      expect(byHandle.get('ops.accounts')).toMatchObject({ platformOperator: true, memberships: [], status: 'active' });
      expect(byHandle.get('rina.acc')).toMatchObject({
        kind: 'person', status: 'active', mfaEnrolled: false, locked: false, platformOperator: false,
        memberships: [
          { org: 'alpha', orgName: 'PT Alpha Sejahtera', status: 'active', adminRoles: ['tenant_admin'] },
          { org: 'beta', orgName: 'PT Beta Mandiri', status: 'active', adminRoles: [] },
        ],
      });
      expect(byHandle.get('sari.acc')).toMatchObject({ status: 'invited', memberships: [{ org: 'alpha', status: 'invited' }] });
      expect(byHandle.get('dewi.acc')?.mfaEnrolled).toBe(true);
      expect(byHandle.get('rina.acc')?.etag).toMatch(/^W\/"\d+"$/);
      const text = reply.text.toLowerCase();
      for (const secret of ['password', 'hash', 'secret', 'sealed', 'ms_manager', 'recovery']) expect(text, secret).not.toContain(secret);
    });

    it('searches by name, email or handle and filters by organisation, status and kind, paged', async () => {
      const list = async (query: Record<string, unknown>) => (await call<Page<OpsAccountItem>>(op, ACCOUNTS, { query })).body;
      expect((await list({ q: 'Person rina' })).items.map((a) => a.handle)).toEqual(['rina.acc']);
      expect((await list({ q: 'dewi.acc@onboarding' })).items.map((a) => a.handle)).toEqual(['dewi.acc']);
      expect((await list({ q: '%' })).items).toEqual([]);
      expect((await list({ org: 'beta' })).items.map((a) => a.handle).sort()).toEqual(['dewi.acc', 'rina.acc']);
      expect((await list({ org: 'nowhere' })).items).toEqual([]);
      expect((await list({ status: 'invited' })).items.map((a) => a.handle)).toContain('sari.acc');
      expect((await list({ status: 'invited' })).items.every((a) => a.status === 'invited')).toBe(true);
      expect((await list({ kind: 'system' })).items.map((a) => a.handle)).toEqual(['system']);
      const first = await list({ pageSize: 2, page: 1 });
      const second = await list({ pageSize: 2, page: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.total).toBeGreaterThanOrEqual(5);
      expect(second.items.map((a) => a.id)).not.toContain(first.items[0]!.id);
    });

    it('is refused to a Tenant Admin, who keeps the members of their own organisation only', async () => {
      const admin = await sessionIn(full, rina.id, { id: alpha.id, schemaName: alpha.schemaName });
      const reply = await call(admin, ACCOUNTS);
      expect(reply.status).toBe(403);
    });
  });

  describe('GET /ops/accounts/{id}', () => {
    it('shows the open sessions with the network cut to /24 or /48 and the browser, and the audit entries', async () => {
      await sessionIn(full, dewi.id, { id: beta.id, schemaName: beta.schemaName });
      await stampSessions(db, dewi.id, '203.0.113.77', CHROME_WINDOWS);
      await sessionIn(full, dewi.id, { id: beta.id, schemaName: beta.schemaName });
      await inPlatform(db, (trx) =>
        sql`update platform.session set ip = '2001:db8:1234:5678::1'::inet, user_agent = ${SAFARI_IPHONE} where user_id = ${dewi.id} and ip is null and revoked_at is null`.execute(trx),
      );
      const reply = await call<OpsAccountDetail>(op, ACCOUNT, { params: { id: dewi.id } });
      expect(reply.status).toBe(200);
      expect(OpsAccountDetail.safeParse(reply.body).success).toBe(true);
      const networks = reply.body.sessions.map((s) => [s.network, s.browser, s.org, s.method]).sort();
      expect(networks).toEqual([
        ['2001:db8:1234::/48', 'Safari 17, iOS', 'beta', 'local'],
        ['203.0.113.0/24', 'Chrome 130, Windows', 'beta', 'local'],
      ]);
      expect(reply.text).not.toContain('203.0.113.77');
      expect(reply.text).not.toContain('AppleWebKit');
      expect((await call(op, ACCOUNT, { params: { id: '00000000-0000-4000-8000-00000000dead' } })).status).toBe(404);
    });
  });

  describe('POST /ops/accounts/{id}/reset-mfa', () => {
    it('removes the factor and the recovery codes, ends the sessions, emails the account and audits the reason', async () => {
      const person = await addPerson(db, 'mfa.reset', [{ org: alpha }], { password: true });
      await addFactor(db, person.id);
      const client = await sessionIn(full, person.id, { id: alpha.id, schemaName: alpha.schemaName });
      const reply = await call<OpsAccountActionResult>(op, RESET_MFA, { params: { id: person.id }, body: { reason: REASON } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.data).toMatchObject({ id: person.id, sessionsRevoked: 1, status: 'active', emailed: true });
      expect(reply.body.message?.[0]).toContain('the account was told by email');
      expect((await client.get('/api/v1/me')).status).toBe(401);
      const factors = await inPlatform(db, (trx) => trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', person.id).where('deleted_at', 'is', null).execute());
      expect(factors).toEqual([]);
      const codes = await inPlatform(db, (trx) => trx.selectFrom('platform.mfa_recovery_code').select('id').where('user_id', '=', person.id).where('deleted_at', 'is', null).execute());
      expect(codes).toEqual([]);
      await mail.waitFor(person.email, (m) => m.mailKind.endsWith(':mfa_reset'));
      const [entry] = await auditAbout(db, person.id, 'auth.mfa_reset');
      expect(entry).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id, organization_id: null, entity_code: 'mfa.reset' });
      expect(entry!.after_data).toMatchObject({ reason: REASON, by: 'platform_operator', factorsRemoved: 1, sessionsRevoked: 1 });
    });

    it('refuses an account without a factor (409 no_second_factor), the system account and an unknown account', async () => {
      const none = await call(op, RESET_MFA, { params: { id: rina.id }, body: { reason: REASON } });
      expect([none.status, none.body.messageKey]).toEqual([409, 'no_second_factor']);
      expect(none.body.messages?.id).toBeTruthy();
      const system = await call(op, RESET_MFA, { params: { id: SYSTEM_USER_ID }, body: { reason: REASON } });
      expect([system.status, system.body.messageKey]).toEqual([409, 'system_account']);
      const unknown = await call(op, RESET_MFA, { params: { id: '00000000-0000-4000-8000-00000000dead' }, body: { reason: REASON } });
      expect([unknown.status, unknown.body.messageKey]).toEqual([404, 'unknown_account']);
      expect(unknown.body.messages?.id).toBeTruthy();
      expect((await call(op, RESET_MFA, { params: { id: rina.id }, body: { reason: 'no' } })).status).toBe(400);
    });

    it('never resets the operator\'s own factor, which would end their own sessions (403 own_account)', async () => {
      await addFactor(db, operator.id);
      const open = (await sessionsOf(db, operator.id)).open;
      expect(open).toBeGreaterThan(0);
      try {
        const own = await call(op, RESET_MFA, { params: { id: operator.id }, body: { reason: REASON } });
        expect([own.status, own.body.messageKey]).toEqual([403, 'own_account']);
        expect(own.body.messages?.id).toBeTruthy();
        expect((await op.get('/api/v1/me')).status).toBe(200);
        expect((await sessionsOf(db, operator.id)).open).toBe(open);
        const factors = await inPlatform(db, (trx) => trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', operator.id).where('deleted_at', 'is', null).execute());
        expect(factors).toHaveLength(1);
        expect(await auditAbout(db, operator.id, 'auth.mfa_reset')).toEqual([]);
      } finally {
        await inPlatform(db, async (trx) => {
          await trx.updateTable('platform.mfa_factor').set({ deleted_at: new Date() }).where('user_id', '=', operator.id).where('deleted_at', 'is', null).execute();
          await trx.updateTable('platform.mfa_recovery_code').set({ deleted_at: new Date() }).where('user_id', '=', operator.id).where('deleted_at', 'is', null).execute();
        });
      }
    });
  });

  describe('POST /ops/accounts/{id}/password-reset', () => {
    it('emails a one-time link that sets a new password; an older link stops working', async () => {
      const person = await addPerson(db, 'pw.reset', [{ org: alpha }], { password: true });
      const first = await call<OpsAccountActionResult>(op, PASSWORD_RESET, { params: { id: person.id }, body: { reason: REASON } });
      expect(first.status, first.text).toBe(200);
      expect(first.body.data).toMatchObject({ emailed: true, sessionsRevoked: 0 });
      expect(first.body.data.link).toBeUndefined();
      const firstMail = await mail.waitFor(person.email, (m) => m.mailKind.endsWith(':password_reset'));
      const firstToken = /reset-password#token=([A-Za-z0-9_-]+)/.exec(firstMail.text)?.[1];
      expect(firstToken).toBeTruthy();
      await mail.clear();
      await call(op, PASSWORD_RESET, { params: { id: person.id }, body: { reason: REASON } });
      const secondMail = await mail.waitFor(person.email, (m) => m.mailKind.endsWith(':password_reset'));
      const secondToken = /reset-password#token=([A-Za-z0-9_-]+)/.exec(secondMail.text)?.[1];
      expect(secondToken).toBeTruthy();
      const anon = anonymous(full);
      const stale = await anon.post('/api/v1/auth/password/reset', { token: firstToken, password: 'A-new-password-for-test-77' });
      expect(stale.status).toBe(400);
      const used = await anon.post('/api/v1/auth/password/reset', { token: secondToken, password: 'A-new-password-for-test-77' });
      expect(used.status, used.text).toBe(204);
      const entries = await auditAbout(db, person.id, 'auth.password_reset');
      expect(entries[0]).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id });
      expect(entries[0]!.after_data).toMatchObject({ step: 'link_sent', reason: REASON, by: 'platform_operator', mailReady: true });
      expect(entries[1]!.after_data).toMatchObject({ olderLinksEnded: 1 });
    });

    it('refuses an invited, a guest, an SSO-only account, an account without a membership and the system account', async () => {
      const invited = await call(op, PASSWORD_RESET, { params: { id: sari.id }, body: { reason: REASON } });
      expect([invited.status, invited.body.messageKey]).toEqual([409, 'account_not_active']);
      const guestId = await inPlatform(db, async (trx) => (await trx
        .insertInto('platform.app_user')
        .values({ handle: 'guest.acc', email: 'auditor@cb.example', display_name: 'Guest Auditor', kind: 'guest', status: 'active', mfa_required: false })
        .returning('id')
        .executeTakeFirstOrThrow()).id);
      const guest = await call(op, PASSWORD_RESET, { params: { id: guestId }, body: { reason: REASON } });
      expect([guest.status, guest.body.messageKey]).toEqual([409, 'guest_account']);
      const gamma = await createTenant(db, 'gamma', { name: 'PT Gamma SSO' });
      await sql`update platform.organization set local_login = 'disabled' where id = ${gamma.id}`.execute(db.migrator);
      const sso = await addPerson(db, 'sso.only', [{ org: gamma }], { password: true });
      const refused = await call(op, PASSWORD_RESET, { params: { id: sso.id }, body: { reason: REASON } });
      expect([refused.status, refused.body.messageKey]).toEqual([409, 'local_login_not_allowed']);
      const system = await call(op, PASSWORD_RESET, { params: { id: SYSTEM_USER_ID }, body: { reason: REASON } });
      expect([system.status, system.body.messageKey]).toEqual([409, 'system_account']);
      const lonely = await addPerson(db, 'no.membership', [], { password: true });
      const none = await call(op, PASSWORD_RESET, { params: { id: lonely.id }, body: { reason: REASON } });
      expect([none.status, none.body.messageKey]).toEqual([409, 'no_membership']);
    });
  });

  describe('POST /ops/accounts/{id}/invitations/{org}/resend', () => {
    it('revokes the older invitation link and emails a new one that the person accepts', async () => {
      // An organisation without a licence takes one active member (UNLICENSED_MEMBER_ALLOWANCE): the person accepting.
      const epsilon = await createTenant(db, 'epsilon', { name: 'PT Epsilon Baru' });
      const person = await addPerson(db, 'invite.again', [{ org: epsilon, status: 'invited', invitedBy: rina.id }], { status: 'invited' });
      const old = await inPlatform(db, (trx) =>
        trx.insertInto('platform.invitation').values({
          token_hash: Buffer.from('old-invitation-hash-of-the-test'), organization_id: epsilon.id, user_id: person.id, email: person.email, created_by: rina.id,
          expires_at: new Date(Date.now() + 3_600_000),
        }).returning('id').executeTakeFirstOrThrow(),
      );
      const reply = await call<OpsAccountActionResult>(op, RESEND, { params: { id: person.id, org: 'epsilon' }, body: { reason: REASON } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.data).toMatchObject({ emailed: true, status: 'invited' });
      const rows = await inPlatform(db, (trx) => trx.selectFrom('platform.invitation').select(['id', 'revoked_at', 'created_by']).where('user_id', '=', person.id).orderBy('created_at').execute());
      expect(rows.find((r) => r.id === old.id)?.revoked_at).not.toBeNull();
      expect(rows.filter((r) => r.revoked_at === null).map((r) => r.created_by)).toEqual([operator.id]);
      const message = await mail.waitFor(person.email, (m) => m.mailKind.endsWith(':invitation'));
      expect(message.text).toContain('PT Epsilon Baru');
      const token = /invite#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
      const accepted = await anonymous(full).post('/api/v1/auth/invitations/accept', { token, password: PASSWORD });
      expect(accepted.status, accepted.text).toBe(200);
      const entries = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.audit_log').select(['actor_kind', 'organization_id', 'entity_type', 'after_data']).where('action', '=', 'user.invited').where('entity_code', '=', 'invite.again').execute(),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_kind: 'operator', organization_id: epsilon.id, entity_type: 'invitation' });
      expect(entries[0]!.after_data).toMatchObject({ resent: true, reason: REASON, olderLinksRevoked: 1 });
    });

    it('refuses a membership that is not invited, an organisation without a membership and an unknown organisation', async () => {
      const active = await call(op, RESEND, { params: { id: rina.id, org: 'alpha' }, body: { reason: REASON } });
      expect([active.status, active.body.messageKey]).toEqual([409, 'membership_not_invited']);
      const noMembership = await call(op, RESEND, { params: { id: sari.id, org: 'beta' }, body: { reason: REASON } });
      expect([noMembership.status, noMembership.body.messageKey]).toEqual([404, 'membership_not_found']);
      const nowhere = await call(op, RESEND, { params: { id: sari.id, org: 'nowhere' }, body: { reason: REASON } });
      expect([nowhere.status, nowhere.body.messageKey]).toEqual([404, 'unknown_organisation']);
      expect(nowhere.body.messages?.id).toContain('nowhere');
    });
  });

  describe('POST /ops/accounts/{id}/sessions/revoke', () => {
    it('ends every session of the account and audits the reason; never the operator\'s own sessions', async () => {
      const person = await addPerson(db, 'sessions.end', [{ org: alpha }, { org: beta }], { password: true });
      const inAlpha = await sessionIn(full, person.id, { id: alpha.id, schemaName: alpha.schemaName });
      const inBeta = await sessionIn(full, person.id, { id: beta.id, schemaName: beta.schemaName });
      const reply = await call<OpsAccountActionResult>(op, REVOKE, { params: { id: person.id }, body: { reason: REASON } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.data.sessionsRevoked).toBe(2);
      expect((await inAlpha.get('/api/v1/me')).status).toBe(401);
      expect((await inBeta.get('/api/v1/me')).status).toBe(401);
      expect(await sessionsOf(db, person.id)).toEqual({ open: 0, reasons: ['operator_revoked', 'operator_revoked'] });
      const [entry] = await auditAbout(db, person.id, 'auth.session_revoked');
      expect(entry!.after_data).toMatchObject({ reason: REASON, sessionsRevoked: 2, by: 'platform_operator' });
      const own = await call(op, REVOKE, { params: { id: operator.id }, body: { reason: REASON } });
      expect([own.status, own.body.messageKey]).toEqual([403, 'own_account']);
      expect((await op.get('/api/v1/me')).status).toBe(200);
    });
  });

  describe('POST /ops/accounts/{id}/status', () => {
    it('disables an account (every session ends) and enables it again, with If-Match', async () => {
      // An organisation without a licence takes one active member (UNLICENSED_MEMBER_ALLOWANCE): this person alone.
      const delta = await createTenant(db, 'delta', { name: 'PT Delta Kecil' });
      const person = await addPerson(db, 'status.change', [{ org: delta }], { password: true });
      const client = await sessionIn(full, person.id, { id: delta.id, schemaName: delta.schemaName });
      const before = await call<OpsAccountDetail>(op, ACCOUNT, { params: { id: person.id } });
      const stale = await call(op, STATUS, { params: { id: person.id }, body: { status: 'disabled', reason: REASON }, headers: { 'if-match': 'W/"1"' } });
      expect(stale.status).toBe(412);
      const disabled = await call<OpsAccountActionResult>(op, STATUS, { params: { id: person.id }, body: { status: 'disabled', reason: REASON }, headers: { 'if-match': before.body.etag } });
      expect(disabled.status, disabled.text).toBe(200);
      expect(disabled.body.data).toMatchObject({ status: 'disabled', sessionsRevoked: 1 });
      expect((await client.get('/api/v1/me')).status).toBe(401);
      const signIn = await anonymous(full).post('/api/v1/auth/login', { email: person.email, password: PASSWORD, remember: false });
      expect(signIn.status).toBe(401);
      const again = await call(op, STATUS, { params: { id: person.id }, body: { status: 'disabled', reason: REASON } });
      expect([again.status, again.body.messageKey]).toEqual([409, 'status_unchanged']);
      const enabled = await call<OpsAccountActionResult>(op, STATUS, { params: { id: person.id }, body: { status: 'active', reason: 'Back after the leave' } });
      expect(enabled.status, enabled.text).toBe(200);
      expect(enabled.body.data.status).toBe('active');
      const entries = await auditAbout(db, person.id, 'user.updated');
      expect(entries.map((e) => [e.actor_kind, (e.after_data as { accountStatus?: string }).accountStatus])).toEqual([['operator', 'disabled'], ['operator', 'active']]);
      expect(entries[0]!.before_data).toEqual({ accountStatus: 'active' });
      expect(entries[0]!.after_data).toMatchObject({ reason: REASON, sessionsRevoked: 1 });
    });

    it('enables an account only within the user limit of each of its organisations (LIC-USERS)', async () => {
      // alpha has no licence and several active members already, so one more active member is over its limit.
      const person = await addPerson(db, 'over.limit', [{ org: alpha }], { password: true, status: 'disabled' });
      const refused = await call(op, STATUS, { params: { id: person.id }, body: { status: 'active', reason: REASON } });
      expect([refused.status, refused.body.messageKey]).toEqual([422, 'licence.no_licence']);
      const row = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('status').where('id', '=', person.id).executeTakeFirstOrThrow());
      expect(row.status).toBe('disabled');
    });

    it('refuses the own account, an invited account, the system account and the last active operator', async () => {
      const own = await call(op, STATUS, { params: { id: operator.id }, body: { status: 'disabled', reason: REASON } });
      expect([own.status, own.body.messageKey]).toEqual([403, 'own_account']);
      const invited = await call(op, STATUS, { params: { id: sari.id }, body: { status: 'active', reason: REASON } });
      expect([invited.status, invited.body.messageKey]).toEqual([409, 'account_invited']);
      // Nor is an invited account disabled: enabling it again would make it active without an accepted invitation.
      const invitedOff = await call(op, STATUS, { params: { id: sari.id }, body: { status: 'disabled', reason: REASON } });
      expect([invitedOff.status, invitedOff.body.messageKey]).toEqual([409, 'account_invited']);
      expect(invitedOff.body.messages?.en).toContain('It can be disabled after that.');
      expect(invitedOff.body.messages?.id).toBeTruthy();
      const sariRow = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('status').where('id', '=', sari.id).executeTakeFirstOrThrow());
      expect(sariRow.status).toBe('invited');
      expect(await auditAbout(db, sari.id, 'user.updated')).toEqual([]);
      const system = await call(op, STATUS, { params: { id: SYSTEM_USER_ID }, body: { status: 'disabled', reason: REASON } });
      expect([system.status, system.body.messageKey]).toEqual([409, 'system_account']);
      // The guard only lets an active operator act, so the last-operator rule is checked on the service: the acting
      // operator's own role has ended in the meantime, and the other operator is the last active one.
      const other = await addPerson(db, 'ops.last', [], { platformOperator: true, password: true });
      await inPlatform(db, (trx) => sql`update platform.platform_role set revoked_at = now() where user_id = ${operator.id}`.execute(trx));
      try {
        const service = full.get<OpsAccountsService>(OpsAccountsService);
        const principal = { user: { id: operator.id, handle: operator.handle, displayName: operator.displayName } } as unknown as Principal;
        await expect(service.changeStatus(principal, other.id, { status: 'disabled', reason: REASON }, undefined)).rejects.toMatchObject({ extras: { messageKey: 'last_operator' } });
      } finally {
        await inPlatform(db, (trx) => sql`update platform.platform_role set revoked_at = null where user_id = ${operator.id}`.execute(trx));
      }
    });

    it('two operators who disable each other at the same moment wait for each other instead of deadlocking', async () => {
      // A third session holds the lower of the two accounts, so both disables are inside their transactions before
      // either goes on. Each disable locks the active operator accounts in id order before its target, so the second
      // waits for the first; with the target locked first, the two would each hold a row the other wants.
      const one = await addPerson(db, 'ops.pair.one', [], { platformOperator: true, password: true });
      const two = await addPerson(db, 'ops.pair.two', [], { platformOperator: true, password: true });
      const [lower, higher] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1)) as [Person, Person];
      const service = full.get<OpsAccountsService>(OpsAccountsService);
      const principalOf = (p: Person) => ({ user: { id: p.id, handle: p.handle, displayName: p.displayName } }) as unknown as Principal;
      const waiting = async (): Promise<number> => {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
           where a.datname = current_database() and not l.granted`.execute(db.migrator);
        return rows[0]?.n ?? 0;
      };
      const waitFor = async (n: number): Promise<void> => {
        for (let i = 0; i < 400; i += 1) {
          if ((await waiting()) >= n) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`fewer than ${n} sessions wait for a lock`);
      };
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const holder = inPlatform(db, async (trx) => {
        await sql`select id from platform.app_user where id = ${lower.id} for update`.execute(trx);
        held();
        await released;
      });
      await holding;
      let first: Promise<OpsAccountActionResult> | undefined;
      let second: Promise<OpsAccountActionResult> | undefined;
      let failure: unknown = null;
      try {
        first = service.changeStatus(principalOf(higher), lower.id, { status: 'disabled', reason: REASON }, undefined);
        await waitFor(1);
        second = service.changeStatus(principalOf(lower), higher.id, { status: 'disabled', reason: REASON }, undefined);
        await waitFor(2);
      } catch (error) {
        failure = error;
      } finally {
        release();
        await holder;
      }
      const outcomes = await Promise.allSettled([first, second]);
      if (failure) throw failure;
      expect(outcomes.map((o) => (o.status === 'rejected' ? String((o.reason as Error).message) : o.status))).toEqual(['fulfilled', 'fulfilled']);
      const rows = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select(['id', 'status']).where('id', 'in', [one.id, two.id]).execute());
      expect(rows.map((r) => r.status)).toEqual(['disabled', 'disabled']);
    });
  });

  it('lists the actions of the operator in the detail, with the reason, newest first', async () => {
    const reply = await call<OpsAccountDetail>(op, ACCOUNT, { params: { id: dewi.id } });
    expect(reply.status).toBe(200);
    expect(reply.body.audit.length).toBeGreaterThanOrEqual(0);
    const person = await addPerson(db, 'audit.view', [{ org: alpha }], { password: true });
    await call(op, REVOKE, { params: { id: person.id }, body: { reason: 'First action of the test' } });
    await call(op, STATUS, { params: { id: person.id }, body: { status: 'disabled', reason: 'Second action of the test' } });
    const detail = await call<OpsAccountDetail>(op, ACCOUNT, { params: { id: person.id } });
    expect(detail.body.audit.slice(0, 2).map((a) => [a.action, a.reason, a.actor?.handle])).toEqual([
      ['user.updated', 'Second action of the test', 'ops.accounts'],
      ['auth.session_revoked', 'First action of the test', 'ops.accounts'],
    ]);
    expect(detail.body.status).toBe('disabled');
  });
});

describe('the mail rule of the account actions (Milestone 2 M2-19)', () => {
  const db = useTestDatabase('empty');
  let operator: Person;
  let alpha: CreatedTenant;

  beforeAll(async () => {
    alpha = await createTenant(db, 'alpha', { name: 'PT Alpha Sejahtera' });
    operator = await addPerson(db, 'ops.mailrule', [], { platformOperator: true, password: true });
  });

  it('with mail.required and mail not working, refuses before anything is written (409 mail_required)', async () => {
    const full = await createOnboardingApp(db, { mail: null, env: { MSCD__MAIL__REQUIRED: 'true' } });
    try {
      const op = await sessionIn(full, operator.id, null);
      const person = await addPerson(db, 'mail.required', [{ org: alpha }], { password: true });
      const reply = await call(op, PASSWORD_RESET, { params: { id: person.id }, body: { reason: REASON } });
      expect([reply.status, reply.body.messageKey]).toEqual([409, 'mail_required']);
      expect(reply.body.messages?.en).toContain('Mail is required');
      const tokens = await inPlatform(db, (trx) => trx.selectFrom('platform.password_reset_token').select('user_id').where('user_id', '=', person.id).execute());
      expect(tokens).toEqual([]);
      expect(await auditAbout(db, person.id, 'auth.password_reset')).toEqual([]);
    } finally {
      await full.close();
    }
  });

  it('resets a second factor while mail does not work and says that its email did not go out', async () => {
    const full = await createOnboardingApp(db, { mail: null, env: { MSCD__MAIL__REQUIRED: 'true' } });
    try {
      const op = await sessionIn(full, operator.id, null);
      const person = await addPerson(db, 'mfa.nomail', [{ org: alpha }], { password: true });
      await addFactor(db, person.id);
      const reply = await call<OpsAccountActionResult>(op, RESET_MFA, { params: { id: person.id }, body: { reason: REASON } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.data).toMatchObject({ id: person.id, emailed: false });
      expect(reply.body.message?.[0]).toContain('could not be sent');
      expect(reply.body.message?.[0]).not.toContain('was told by email');
      const factors = await inPlatform(db, (trx) => trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', person.id).where('deleted_at', 'is', null).execute());
      expect(factors).toEqual([]);
      expect(await auditAbout(db, person.id, 'auth.mfa_reset')).toHaveLength(1);
    } finally {
      await full.close();
    }
  });

  it('without mail.required and mail not working, answers the one-time link once', async () => {
    const full = await createOnboardingApp(db, { mail: null });
    try {
      const op = await sessionIn(full, operator.id, null);
      const person = await addPerson(db, 'mail.off', [{ org: alpha }], { password: true });
      const reply = await call<OpsAccountActionResult>(op, PASSWORD_RESET, { params: { id: person.id }, body: { reason: REASON } });
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.data.emailed).toBe(false);
      expect(reply.body.data.link).toMatch(/\/reset-password#token=/);
      expect(reply.body.data.expiresAt).toBeTruthy();
    } finally {
      await full.close();
    }
  });
});
