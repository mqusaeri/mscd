// The platform operator (Milestone 2 D.1, D.2): `POST /ops/organizations` in multi tenancy (the organisation with
// local sign-in allowed and its first administrator invited by email; 409 in single tenancy, 409 `mail_required` when
// `mail.required` is true and SMTP does not work, the one-time link only where mail is not required), `GET
// /ops/organizations`, `POST /ops/users/reset-mfa` for an account with memberships in two organisations, and the
// commands `admin create-operator` (with the redemption of its set-password link and the forced authenticator
// enrolment at the first sign-in), `admin revoke-operator`, `admin create-user` (emailed invitation),
// `license show-id` and `tenant create --if-missing` (the first step of the Helm admin Job, which may run again).
import path from 'node:path';
import { API_ROUTES, OpsOrganizationCreateResult, type OpsOrganizationItem, type Page } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCreateOperator, adminCreateUser, adminRevokeOperator } from '../../../src/cli/admin';
import { licenseShowId } from '../../../src/cli/license';
import { tenantCreateIfMissing } from '../../../src/cli/tenant';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { sha256 } from '../../../src/modules/identity/tokens';
import { base32Decode, newTotpSecret, totpAt } from '../../../src/modules/identity/totp';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { buildProgram } from '../../../src/program';
import { createTenant, TestDataKeyIssuer } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { Browser, startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, createOnboardingApp, inPlatform, inTenant, PASSWORD, platformAudit, resetRateLimits, sessionIn, type Client, type Person } from './helpers';

const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
const CREATE = route('ops.organizations.create');
const LIST = route('ops.organizations.list');
const RESET = route('ops.users.reset-mfa');
const SET_PASSWORD = '/api/v1/auth/password/reset';
const MULTI = { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' };
const TRIAL = { MSCD__LICENSE__PLANS__TRIAL: '{max_users: 5, max_management_systems: 1, valid_days: 30}' };

const organisation = (slug: string, email: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: `PT ${slug.replace(/_/g, ' ')}`,
  timeZone: 'Asia/Jakarta',
  siteCount: 2,
  firstAdmin: { email, displayName: `Admin of ${slug}` },
  ...extra,
});

async function organizationRow(db: ReturnType<typeof useTestDatabase>, slug: string) {
  return inPlatform(db, (trx) =>
    trx.selectFrom('platform.organization').select(['id', 'slug', 'name', 'time_zone', 'site_count', 'local_login', 'status', 'schema_name']).where('slug', '=', slug).executeTakeFirst(),
  );
}

describe('platform operator (Milestone 2 D.1, D.2)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let operator: Person;
  let op: Client;
  let home: CreatedTenant;
  let other: CreatedTenant;
  let homeAdmin: Person;

  beforeAll(async () => {
    mail = await startMailpit();
    home = await createTenant(db, 'home', { name: 'PT Home' });
    other = await createTenant(db, 'other', { name: 'PT Other' });
    homeAdmin = await addPerson(db, 'home.admin', [{ org: home, adminRoles: ['tenant_admin'] }], { password: true });
    operator = await addPerson(db, 'ops.owner', [], { platformOperator: true, password: true });
    full = await createOnboardingApp(db, { mail, env: { ...MULTI, ...TRIAL } });
    op = await sessionIn(full, operator.id, null);
  });
  afterAll(async () => {
    await full?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  describe('POST /ops/organizations in multi tenancy', () => {
    it('creates the organisation with local sign-in allowed and emails the invitation of its first administrator', async () => {
      const call = await callRoute<OpsOrganizationCreateResult>(op, CREATE, {
        body: organisation('bank_sentosa', 'andi@banksentosa.test', { name: 'PT Bank Sentosa', timeZone: 'asia/jakarta', siteCount: 3, preset: 'trial' }),
      });
      expect(call.violations).toEqual([]);
      expect(call.status, call.text).toBe(201);
      expect(OpsOrganizationCreateResult.safeParse(call.body).success).toBe(true);
      expect(call.body.data).toEqual({ id: expect.any(String), slug: 'bank_sentosa', invitationSent: true });
      expect(call.body.message?.[0]).toContain('The slug bank_sentosa cannot be changed.');
      expect(call.body.message?.[0]).toContain('The invitation was sent to andi@banksentosa.test.');

      const row = await organizationRow(db, 'bank_sentosa');
      expect(row).toMatchObject({ id: call.body.data.id, name: 'PT Bank Sentosa', time_zone: 'Asia/Jakarta', site_count: 3, local_login: 'allowed', status: 'active' });
      // The schema exists with its Managed Vault repository.
      const vault = await inTenant(db, { id: row!.id, slug: row!.slug, schemaName: row!.schema_name } as CreatedTenant, (trx) =>
        trx.selectFrom('storage_repository').select(['slug', 'adapter']).execute(),
      );
      expect(vault).toEqual([{ slug: 'vault', adapter: 'managed_vault' }]);

      // The first administrator: a new invited account with an invited Tenant Admin membership.
      const admin = await inPlatform(db, (trx) =>
        trx
          .selectFrom('platform.app_user as u')
          .innerJoin('platform.org_membership as m', 'm.user_id', 'u.id')
          .select(['u.status', 'u.display_name', 'm.status as membership', 'm.admin_roles', 'm.organization_id'])
          .where('u.email', '=', 'andi@banksentosa.test')
          .executeTakeFirstOrThrow(),
      );
      expect(admin).toEqual({ status: 'invited', display_name: 'Admin of bank_sentosa', membership: 'invited', admin_roles: ['tenant_admin'], organization_id: row!.id });
      const invitation = await mail.waitFor('andi@banksentosa.test', (m) => m.mailKind === 'account:invitation');
      expect(invitation.text).toContain('PT Bank Sentosa');

      expect(await platformAudit(db, 'ops.organization_created')).toEqual([
        expect.objectContaining({
          organization_id: row!.id,
          actor_kind: 'operator',
          actor_user_id: operator.id,
          entity_code: 'bank_sentosa',
          after_data: expect.objectContaining({ localLogin: 'allowed', timeZone: 'Asia/Jakarta', preset: 'trial', mailReady: true, firstAdmin: expect.objectContaining({ newAccount: true }) }),
        }),
      ]);
      expect((await platformAudit(db, 'tenant.created')).map((e) => e.entity_code)).toContain('bank_sentosa');
    });

    it('invites an existing active account as first administrator with the email and the notification instead of a link', async () => {
      const call = await callRoute<OpsOrganizationCreateResult>(op, CREATE, { body: organisation('second_org', homeAdmin.email.toUpperCase()) });
      expect(call.violations).toEqual([]);
      expect(call.status, call.text).toBe(201);
      expect(call.body.data).toEqual({ id: expect.any(String), slug: 'second_org', invitationSent: true });
      await mail.waitFor(homeAdmin.email, (m) => m.mailKind === 'account:membership_invited' && m.text.includes('PT second org'));
      const membership = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select(['status', 'admin_roles']).where('user_id', '=', homeAdmin.id).where('organization_id', '=', call.body.data.id).executeTakeFirstOrThrow(),
      );
      expect(membership).toEqual({ status: 'invited', admin_roles: ['tenant_admin'] });
      const notified = await (async () => {
        for (let i = 0; i < 100; i += 1) {
          const rows = await inTenant(db, home, (trx) => trx.selectFrom('notification').select(['kind', 'title_en']).where('recipient_user_id', '=', homeAdmin.id).execute());
          if (rows.length > 0) return rows;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return [];
      })();
      expect(notified).toEqual([{ kind: 'membership_invited', title_en: 'Invitation to PT second org' }]);
    });

    it('refuses a taken slug (409 org_exists), an unknown preset (422), an unknown time zone (400) and a disabled first administrator (409)', async () => {
      const taken = await callRoute(op, CREATE, { body: organisation('bank_sentosa', 'someone@banksentosa.test') });
      expect(taken.violations).toEqual([]);
      expect(taken.status).toBe(409);
      expect(taken.text).toContain('org_exists');

      const preset = await callRoute(op, CREATE, { body: organisation('preset_org', 'x@preset.test', { preset: 'enterprise' }) });
      expect(preset.status).toBe(422);
      expect(preset.text).toContain('unknown_preset');

      const zone = await callRoute(op, CREATE, { body: organisation('zone_org', 'x@zone.test', { timeZone: 'Mars/Olympus_Mons' }) });
      expect(zone.status).toBe(400);
      expect(zone.text).toContain('body.timeZone');

      const disabled = await addPerson(db, 'disabled.person', [], { status: 'disabled' });
      const refused = await callRoute(op, CREATE, { body: organisation('disabled_org', disabled.email) });
      expect(refused.status).toBe(409);
      expect(refused.text).toContain('first_admin_disabled');
      for (const slug of ['preset_org', 'zone_org', 'disabled_org']) expect(await organizationRow(db, slug)).toBeUndefined();
    });

    it('lists the organisations with status, licence, members, systems and domains, with search and paging', async () => {
      const call = await callRoute<Page<OpsOrganizationItem>>(op, LIST, { query: { q: 'sentosa' } });
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(200);
      expect(call.body.total).toBe(1);
      expect(call.body.items).toEqual([
        {
          id: expect.any(String),
          slug: 'bank_sentosa',
          name: 'PT Bank Sentosa',
          status: 'active',
          licence: null,
          memberCount: 0,
          systemCount: 0,
          plan: null,
          validUntil: null,
          verifiedDomains: [],
          createdAt: expect.any(String),
        },
      ]);
      const all = await op.get<Page<OpsOrganizationItem>>('/api/v1/ops/organizations?pageSize=200');
      expect(all.body.items.map((o) => o.slug).sort()).toEqual(['bank_sentosa', 'home', 'other', 'second_org']);
      expect(all.body.items.find((o) => o.slug === 'home')?.memberCount).toBe(1);
    });

    it('answers 403 to a Tenant Admin', async () => {
      const ta = await sessionIn(full, homeAdmin.id, home);
      expect((await ta.post('/api/v1/ops/organizations', organisation('ta_org', 'x@ta.test'))).status).toBe(403);
      expect((await ta.get('/api/v1/ops/organizations')).status).toBe(403);
    });
  });

  describe('POST /ops/users/reset-mfa', () => {
    it('resets the second factor of an account with two memberships, ends its sessions, audits the reason and emails it', async () => {
      const lina = await addPerson(db, 'lina', [{ org: home }, { org: other, isDefault: false }], { password: true });
      const sealed = await full.get<SecretBox>(SecretBox).seal(newTotpSecret(), { purpose: 'mfa', userId: lina.id });
      await inPlatform(db, async (trx) => {
        await trx.insertInto('platform.mfa_factor').values({ user_id: lina.id, secret_sealed: sealed, confirmed_at: new Date() }).execute();
        await trx.insertInto('platform.mfa_recovery_code').values({ user_id: lina.id, code_hash: 'not-a-real-hash' }).execute();
        await trx.updateTable('platform.app_user').set({ mfa_failed_count: 3, mfa_locked_until: new Date(Date.now() + 3_600_000) }).where('id', '=', lina.id).execute();
      });
      const linaHome = await sessionIn(full, lina.id, home);
      const linaOther = await sessionIn(full, lina.id, other);
      expect((await linaHome.get('/api/v1/me')).status).toBe(200);

      const reason = 'Lost phone, identity checked by video call';
      const call = await callRoute(op, RESET, { body: { email: lina.email.toUpperCase(), reason } });
      expect(call.violations).toEqual([]);
      expect(call.status, call.text).toBe(204);

      const state = await inPlatform(db, async (trx) => ({
        factors: await trx.selectFrom('platform.mfa_factor').select('id').where('user_id', '=', lina.id).where('deleted_at', 'is', null).execute(),
        codes: await trx.selectFrom('platform.mfa_recovery_code').select('id').where('user_id', '=', lina.id).where('deleted_at', 'is', null).execute(),
        user: await trx.selectFrom('platform.app_user').select(['mfa_failed_count', 'mfa_locked_until']).where('id', '=', lina.id).executeTakeFirstOrThrow(),
      }));
      expect(state).toEqual({ factors: [], codes: [], user: { mfa_failed_count: 0, mfa_locked_until: null } });
      expect((await linaHome.get('/api/v1/me')).status).toBe(401);
      expect((await linaOther.get('/api/v1/me')).status).toBe(401);
      expect(await platformAudit(db, 'auth.mfa_reset')).toEqual([
        expect.objectContaining({
          organization_id: null,
          actor_kind: 'operator',
          actor_user_id: operator.id,
          entity_id: lina.id,
          after_data: { reason, by: 'platform_operator', factorsRemoved: 1, sessionsRevoked: 2, activeMemberships: 2 },
        }),
      ]);
      await mail.waitFor(lina.email, (m) => m.mailKind === 'account:mfa_reset');

      // Nothing left to reset, an unknown address, a short reason, and a Tenant Admin.
      expect((await callRoute(op, RESET, { body: { email: lina.email, reason } })).status).toBe(404);
      expect((await callRoute(op, RESET, { body: { email: 'nobody@onboarding.test', reason } })).status).toBe(404);
      expect((await callRoute(op, RESET, { body: { email: lina.email, reason: 'short' } })).status).toBe(400);
      const ta = await sessionIn(full, homeAdmin.id, home);
      expect((await ta.post('/api/v1/ops/users/reset-mfa', { email: lina.email, reason })).status).toBe(403);
    });
  });

  describe('commands', () => {
    const cliConfig = (env: Record<string, string> = {}) =>
      db.config({ MSCD__MAIL__SMTP__HOST: mail.host, MSCD__MAIL__SMTP__PORT: String(mail.smtpPort), ...MULTI, ...env }, 'cli');

    /** Runs the command line in-process against the test database; returns stdout, stderr and the exit code. */
    async function runCli(args: string[]): Promise<{ out: string; err: string; code: number }> {
      vi.stubEnv('MSCD_PROFILE_FILE', path.resolve(__dirname, '../../../profiles/test.yaml'));
      vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL', db.urls.migrator);
      vi.stubEnv('MSCD_DATABASE_MIGRATOR_URL_FILE', '');
      vi.stubEnv('MSCD__OBSERVABILITY__METRICS_PORT', 'null');
      let out = '';
      let err = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => ((err += String(chunk)), true));
      class Exit extends Error {
        constructor(readonly code: number) {
          super(`exit ${code}`);
        }
      }
      vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new Exit(Number(code ?? 0));
      });
      try {
        await buildProgram().exitOverride().parseAsync(['node', 'mscd-server', ...args]);
        return { out, err, code: 0 };
      } catch (error) {
        if (error instanceof Exit) return { out, err, code: error.code };
        throw error;
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }

    it('tenant create --if-missing passes without changes when the slug exists, and creates the organisation otherwise', async () => {
      const issuer = new TestDataKeyIssuer();
      const found = await tenantCreateIfMissing(cliConfig(), { slug: 'home', name: 'Another name' }, issuer);
      expect(found).toEqual({ existing: { id: home.id, slug: 'home', name: 'PT Home', status: 'active' } });
      expect(issuer.issued).toEqual([]);

      const made = await tenantCreateIfMissing(cliConfig(), { slug: 'job_org', name: 'PT Job Org' }, issuer);
      expect(made.created).toMatchObject({ slug: 'job_org', schemaName: 'org_job_org' });
      const again = await tenantCreateIfMissing(cliConfig(), { slug: 'job_org', name: 'PT Job Org' }, issuer);
      expect(again).toEqual({ existing: { id: made.created!.id, slug: 'job_org', name: 'PT Job Org', status: 'active' } });
      expect(issuer.issued).toHaveLength(1);
      expect((await platformAudit(db, 'tenant.created')).filter((e) => e.entity_code === 'job_org')).toHaveLength(1);

      // The command line: exit 0 with --if-missing (a retried admin Job continues), the refusal without it.
      const passed = await runCli(['tenant', 'create', '--slug', 'home', '--name', 'PT Home', '--if-missing']);
      expect(passed).toEqual({
        code: 0,
        err: '',
        out: `tenant create: organisation home (${home.id}) already exists with the name "PT Home" and the status active; nothing changed (--if-missing)\n`,
      });
      const refused = await runCli(['tenant', 'create', '--slug', 'home', '--name', 'PT Home']);
      expect(refused).toEqual({ code: 1, out: '', err: 'tenant create failed: Organisation home already exists\n' });
    });

    it('license show-id prints the installation id', async () => {
      const installation = await inPlatform(db, (trx) => trx.selectFrom('platform.installation').select('id').executeTakeFirstOrThrow());
      expect(await licenseShowId(cliConfig())).toBe(installation.id);
    });

    it('admin create-operator creates an active operator with a one-time set-password link sent by email', async () => {
      const created = await adminCreateOperator(cliConfig({ MSCD__MAIL__REQUIRED: 'true' }), { email: 'Owner@Platform.test', name: 'Platform Owner' });
      expect(created).toMatchObject({ email: 'Owner@Platform.test', newAccount: true, alreadyOperator: false, emailed: true });
      expect(created.link).toContain(`/reset-password#token=${created.token}`);
      const account = await inPlatform(db, async (trx) => ({
        user: await trx.selectFrom('platform.app_user').select(['status', 'mfa_required', 'password_hash', 'display_name']).where('id', '=', created.userId).executeTakeFirstOrThrow(),
        role: await trx.selectFrom('platform.platform_role').select(['role', 'revoked_at']).where('user_id', '=', created.userId).execute(),
        tokens: await trx.selectFrom('platform.password_reset_token').select(['kind', 'token_hash', 'used_at']).where('user_id', '=', created.userId).execute(),
      }));
      expect(account.user).toEqual({ status: 'active', mfa_required: true, password_hash: null, display_name: 'Platform Owner' });
      expect(account.role).toEqual([{ role: 'platform_operator', revoked_at: null }]);
      expect(account.tokens).toEqual([{ kind: 'set_password', token_hash: sha256(created.token!), used_at: null }]);
      const sent = await mail.waitFor('owner@platform.test', (m) => m.mailKind === 'account:operator_invitation');
      expect(sent.text).toContain(created.token!);
      expect(await platformAudit(db, 'ops.operator_created')).toEqual([
        expect.objectContaining({ actor_kind: 'operator', actor_user_id: null, entity_id: created.userId, after_data: expect.objectContaining({ newAccount: true, roleGranted: true, setPasswordLink: true }) }),
      ]);

      // Again before a password is set: a new link, and the old one stops working.
      const again = await adminCreateOperator(cliConfig(), { email: 'owner@platform.test' });
      expect(again).toMatchObject({ newAccount: false, alreadyOperator: true });
      const tokens = await inPlatform(db, (trx) => trx.selectFrom('platform.password_reset_token').select(['token_hash', 'used_at']).where('user_id', '=', created.userId).execute());
      expect(tokens.find((t) => t.token_hash.equals(sha256(created.token!)))?.used_at).not.toBeNull();
      expect(tokens.find((t) => t.token_hash.equals(sha256(again.token!)))?.used_at).toBeNull();
    });

    it('the set-password link of a new operator sets the password once, and the first sign-in must enrol an authenticator', async () => {
      const issued = await adminCreateOperator(cliConfig(), { email: 'owner@platform.test' });
      expect(issued).toMatchObject({ newAccount: false, alreadyOperator: true, emailed: true });
      const sent = await mail.waitFor('owner@platform.test', (m) => m.mailKind === 'account:operator_invitation' && m.text.includes(issued.token!));
      const token = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(sent.text)?.[1];
      expect(token).toBe(issued.token);

      // The emailed link is redeemed where a reset link is (POST /auth/password/reset), and only once.
      const set = await new Browser(full.app).post(SET_PASSWORD, { token, password: PASSWORD });
      expect(set.statusCode, set.body).toBe(204);
      const stored = await inPlatform(db, async (trx) => ({
        user: await trx.selectFrom('platform.app_user').select(['password_hash', 'status']).where('id', '=', issued.userId).executeTakeFirstOrThrow(),
        token: await trx.selectFrom('platform.password_reset_token').select(['kind', 'used_at']).where('token_hash', '=', sha256(token!)).executeTakeFirstOrThrow(),
      }));
      expect(stored.user).toEqual({ password_hash: expect.any(String), status: 'active' });
      expect(stored.token).toEqual({ kind: 'set_password', used_at: expect.any(Date) });
      const reused = await new Browser(full.app).post(SET_PASSWORD, { token, password: 'Yet-Another-Passphrase-9' });
      expect(reused.statusCode).toBe(400);
      expect(reused.json()).toMatchObject({ messageKey: 'auth.reset_invalid' });

      // The first sign-in with the new password must enrol an authenticator before the session may act.
      const browser = new Browser(full.app);
      const signedIn = await browser.login('Owner@Platform.test', PASSWORD);
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      expect(signedIn.json()).toEqual({ status: 'mfa_enrolment_required', csrfToken: expect.any(String) });
      expect((await browser.get('/api/v1/ops/organizations')).statusCode).toBe(401);
      const started = await browser.post('/api/v1/auth/mfa/enrol/start', {});
      expect(started.statusCode, started.body).toBe(200);
      const secret = base32Decode(started.json().secret);
      const confirmed = await browser.post('/api/v1/auth/mfa/enrol/confirm', { code: totpAt(secret, new Date()) });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().me).toMatchObject({ user: { id: issued.userId }, org: null, platformRoles: ['platform_operator'] });
      expect((await browser.get('/api/v1/ops/organizations')).statusCode).toBe(200);
    });

    it('admin create-operator grants the role to an existing account with a password, and refuses a second grant and a disabled account', async () => {
      const granted = await adminCreateOperator(cliConfig(), { email: homeAdmin.email });
      expect(granted).toMatchObject({ newAccount: false, alreadyOperator: false, link: null, token: null, emailed: true });
      await mail.waitFor(homeAdmin.email, (m) => m.mailKind === 'security:operator_granted');
      await expect(adminCreateOperator(cliConfig(), { email: homeAdmin.email })).rejects.toThrow(/already a platform operator/);
      const disabled = await addPerson(db, 'disabled.operator', [], { status: 'disabled' });
      await expect(adminCreateOperator(cliConfig(), { email: disabled.email })).rejects.toThrow(/disabled/);
      await expect(adminCreateOperator(cliConfig(), { email: 'not-an-address' })).rejects.toThrow(/not an email address/);
    });

    it('admin create-operator refuses with mail.required while SMTP does not work, and writes nothing', async () => {
      const config = db.config({ ...MULTI, MSCD__MAIL__REQUIRED: 'true', MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      await expect(adminCreateOperator(config, { email: 'nomail.operator@platform.test' })).rejects.toThrow(/mail/i);
      const account = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', 'nomail.operator@platform.test').executeTakeFirst());
      expect(account).toBeUndefined();
    });

    it('admin revoke-operator ends the role and every session of the account, keeping its memberships', async () => {
      const session = await sessionIn(full, homeAdmin.id, null);
      expect((await session.get('/api/v1/ops/organizations')).status).toBe(200);
      const revoked = await adminRevokeOperator(cliConfig(), { email: homeAdmin.email });
      expect(revoked).toMatchObject({ userId: homeAdmin.id, email: homeAdmin.email });
      expect(revoked.sessionsRevoked).toBeGreaterThanOrEqual(1);
      expect(revoked.operatorsLeft).toBe(2);
      expect((await session.get('/api/v1/ops/organizations')).status).toBe(401);
      const fresh = await sessionIn(full, homeAdmin.id, home);
      expect((await fresh.get('/api/v1/ops/organizations')).status).toBe(403);
      expect((await platformAudit(db, 'ops.operator_revoked')).map((e) => e.entity_id)).toEqual([homeAdmin.id]);
      await expect(adminRevokeOperator(cliConfig(), { email: homeAdmin.email })).rejects.toThrow(/not a platform operator/);
    });

    it('admin create-user emails the invitation, and refuses with mail.required while SMTP does not work', async () => {
      const created = await adminCreateUser(cliConfig(), { email: 'cli.user@banksentosa.test', name: 'CLI User', tenantAdmin: true, org: 'bank_sentosa' });
      expect(created).toMatchObject({ orgSlug: 'bank_sentosa', emailed: true, newAccount: true });
      const sent = await mail.waitFor('cli.user@banksentosa.test', (m) => m.mailKind === 'account:invitation');
      expect(sent.text).toContain('PT Bank Sentosa');
      const refused = db.config({ ...MULTI, MSCD__MAIL__REQUIRED: 'true', MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
      await expect(adminCreateUser(refused, { email: 'never.user@banksentosa.test', org: 'bank_sentosa' })).rejects.toThrow(/mail/i);
      expect(await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', 'never.user@banksentosa.test').executeTakeFirst())).toBeUndefined();
    });
  });
});

describe('POST /ops/organizations without working mail, and in single tenancy', () => {
  const db = useTestDatabase('empty');
  let operator: Person;

  beforeAll(async () => {
    operator = await addPerson(db, 'ops.solo', [], { platformOperator: true, password: true });
  });

  it('answers 409 mail_required with mail.required and SMTP down, and creates nothing', async () => {
    const full = await createOnboardingApp(db, { env: { ...MULTI, MSCD__MAIL__REQUIRED: 'true' } });
    try {
      const op = await sessionIn(full, operator.id, null);
      const call = await callRoute(op, CREATE, { body: organisation('no_mail', 'admin@nomail.test') });
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(409);
      expect(call.text).toContain('mail_required');
      expect(await organizationRow(db, 'no_mail')).toBeUndefined();
      expect(await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', 'admin@nomail.test').executeTakeFirst())).toBeUndefined();
    } finally {
      await full.close();
    }
  });

  it('returns the one-time invitation link once when mail is off and not required', async () => {
    const full = await createOnboardingApp(db, { env: MULTI });
    try {
      const op = await sessionIn(full, operator.id, null);
      const call = await callRoute<OpsOrganizationCreateResult>(op, CREATE, { body: organisation('link_org', 'admin@linkorg.test') });
      expect(call.violations).toEqual([]);
      expect(call.status, call.text).toBe(201);
      expect(call.body.data).toEqual({ id: expect.any(String), slug: 'link_org', invitationSent: false, invitationUrl: expect.stringMatching(/^http.*\/invite/) });
      expect(call.body.message?.[0]).toContain('give the one-time invitation link');
      expect((await organizationRow(db, 'link_org'))?.local_login).toBe('allowed');
    } finally {
      await full.close();
    }
  });

  it('answers 409 single_tenancy in single tenancy', async () => {
    const full = await createOnboardingApp(db);
    try {
      const op = await sessionIn(full, operator.id, null);
      const create = await callRoute(op, CREATE, { body: organisation('single_org', 'admin@single.test') });
      expect(create.violations).toEqual([]);
      expect(create.status).toBe(409);
      expect(create.text).toContain('single_tenancy');
      const list = await callRoute(op, LIST, {});
      expect(list.status).toBe(409);
      expect(list.text).toContain('single_tenancy');
      expect(await organizationRow(db, 'single_org')).toBeUndefined();
    } finally {
      await full.close();
    }
  });
});
