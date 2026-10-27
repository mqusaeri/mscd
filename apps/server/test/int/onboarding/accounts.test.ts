// Accounts across organisations (Milestone 2 D.1, D.2): an existing active account invited by another organisation
// (the same 202 as for a new address, the email and the `membership_invited` notification in its home organisation),
// the pending memberships of `GET /me` (the time of the invitation, not of the last change of its row) with accept and
// decline, new recovery codes (old codes stop working, ten new ones, audit and security email), the security overview
// and `POST /notifications/read-all`.
import { API_ROUTES, Me, MeSecurity, type RecoveryCodesResponse } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../../../src/common/clock';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { MfaService } from '../../../src/modules/identity/mfa.service';
import { hashSecret } from '../../../src/modules/identity/password-hasher';
import { recoveryCodeKey } from '../../../src/modules/identity/recovery-codes';
import { newTotpSecret, totpAt } from '../../../src/modules/identity/totp';
import { SecretBox } from '../../../src/modules/keys/secret-box';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { devLicence } from '../packs/fixtures';
import { addPerson, createOnboardingApp, inPlatform, inTenant, platformAudit, resetRateLimits, sessionIn, type Client, type Person } from './helpers';

const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;

/** The time of the latest `user.invited` entry of an organisation for a user, as `Me.pendingMemberships` shows it. */
async function invitedEntryAt(db: Parameters<typeof inPlatform>[0], orgId: string, userId: string): Promise<string> {
  const row = await inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select('occurred_at')
      .where('action', '=', 'user.invited')
      .where('organization_id', '=', orgId)
      .where('entity_id', '=', userId)
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow(),
  );
  return new Date(row.occurred_at).toISOString();
}

async function until<T>(read: () => Promise<T | undefined | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('accounts across organisations (Milestone 2 D.1, D.2)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let home: CreatedTenant;
  let other: CreatedTenant;
  let otherAdmin: Person;
  let otherTa: Client;

  /** A confirmed authenticator for a person; returns its secret. */
  const addFactor = async (userId: string): Promise<Buffer> => {
    const secret = newTotpSecret();
    const sealed = await full.get<SecretBox>(SecretBox).seal(secret, { purpose: 'mfa', userId });
    await inPlatform(db, (trx) => trx.insertInto('platform.mfa_factor').values({ user_id: userId, secret_sealed: sealed, confirmed_at: new Date() }).execute());
    return secret;
  };
  const me = async (client: Client): Promise<Me> => {
    const call = await callRoute<Me>(client, route('me.get'), {});
    expect(call.violations).toEqual([]);
    expect(Me.safeParse(call.body).success).toBe(true);
    return call.body;
  };

  beforeAll(async () => {
    mail = await startMailpit();
    home = await createTenant(db, 'home', { name: 'PT Home' });
    other = await createTenant(db, 'other', { name: 'PT Other' });
    await addPerson(db, 'home.admin', [{ org: home, adminRoles: ['tenant_admin'] }]);
    otherAdmin = await addPerson(db, 'other.admin', [{ org: other, adminRoles: ['tenant_admin'] }]);
    full = await createOnboardingApp(db, { mail });
    otherTa = await sessionIn(full, otherAdmin.id, other);
    // The other organisation has a licence, so it may add members (LIC-USERS, D-15).
    const licensed = await otherTa.put('/api/v1/admin/license', devLicence(other.id));
    expect(licensed.status, licensed.text).toBe(200);
  });
  afterAll(async () => {
    await full?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  describe('an existing active account invited by another organisation (D.2)', () => {
    let dina: Person;
    let dinaClient: Client;

    beforeAll(async () => {
      dina = await addPerson(db, 'dina', [{ org: home }], { password: true });
      dinaClient = await sessionIn(full, dina.id, home);
    });

    it('answers the same 202 as for a new address and tells the account by email and notification', async () => {
      const create = route('admin.users.create');
      const fresh = await callRoute(otherTa, create, { body: { email: 'new.person@onboarding.test', displayName: 'New Person', adminRoles: [] } });
      const existing = await callRoute(otherTa, create, { body: { email: dina.email.toUpperCase(), displayName: 'Someone Else', adminRoles: [] } });
      expect(fresh.violations).toEqual([]);
      expect(existing.violations).toEqual([]);
      expect([fresh.status, existing.status]).toEqual([202, 202]);
      expect(existing.body).toEqual(fresh.body);
      expect(existing.body).toEqual({ status: 'invited' });

      // The new address gets the invitation link; the existing account an email without a link to set a password.
      const invitation = await mail.waitFor('new.person@onboarding.test', (m) => m.mailKind === 'account:invitation');
      expect(invitation.text).toContain('PT Other');
      const told = await mail.waitFor(dina.email, (m) => m.mailKind === 'account:membership_invited');
      expect(told.text).toContain('PT Other');
      expect(told.text).toContain(otherAdmin.displayName);
      expect(told.text).not.toMatch(/\/invite\//);

      // The notification is written in the account's home organisation, without an email of its own.
      const notification = await until(async () =>
        inTenant(db, home, (trx) =>
          trx.selectFrom('notification').selectAll().where('recipient_user_id', '=', dina.id).where('kind', '=', 'membership_invited').executeTakeFirst(),
        ),
      );
      expect(notification).toMatchObject({ title_en: 'Invitation to PT Other', title_id: 'Undangan ke PT Other', email_status: 'skipped', read_at: null });
      expect(notification.body_en).toContain(`${otherAdmin.displayName} invited you to join PT Other`);
      const listed = await dinaClient.get<{ items: { kind: string; title: [string, string] }[] }>('/api/v1/notifications');
      expect(listed.body.items).toEqual([expect.objectContaining({ kind: 'membership_invited', title: ['Invitation to PT Other', 'Undangan ke PT Other'] })]);

      // The account keeps its own name; the membership waits for its answer.
      const membership = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select(['status', 'invited_by']).where('user_id', '=', dina.id).where('organization_id', '=', other.id).executeTakeFirstOrThrow(),
      );
      expect(membership).toEqual({ status: 'invited', invited_by: otherAdmin.id });
      const account = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select(['display_name', 'status']).where('id', '=', dina.id).executeTakeFirstOrThrow());
      expect(account).toEqual({ display_name: dina.displayName, status: 'active' });
    });

    it('lists the pending membership in GET /me with the organisation, the inviter and the time', async () => {
      const current = await me(dinaClient);
      expect(current.org?.slug).toBe('home');
      const invitedAt = await invitedEntryAt(db, other.id, dina.id);
      expect(current.pendingMemberships).toEqual([{ org: 'other', name: 'PT Other', invitedBy: otherAdmin.displayName, invitedAt }]);
      expect(current.orgs.map((o) => o.id)).toEqual(['home']);

      // A later change of the invited row (its admin roles) moves its updated_at, not the time of the invitation.
      const changeRoles = (roles: ('tenant_admin' | 'storage_admin')[]) =>
        inPlatform(db, (trx) => trx.updateTable('platform.org_membership').set({ admin_roles: roles }).where('user_id', '=', dina.id).where('organization_id', '=', other.id).execute());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await changeRoles(['storage_admin']);
      const changed = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select('updated_at').where('user_id', '=', dina.id).where('organization_id', '=', other.id).executeTakeFirstOrThrow(),
      );
      expect(new Date(changed.updated_at).toISOString() > invitedAt).toBe(true);
      expect((await me(dinaClient)).pendingMemberships).toEqual([expect.objectContaining({ org: 'other', invitedAt })]);
      await changeRoles([]);
    });

    it('accepts the membership: it leaves the pending list and becomes switchable', async () => {
      const accepted = await callRoute<Me>(dinaClient, route('me.membership.accept'), { params: { org: 'other' } });
      expect(accepted.violations).toEqual([]);
      expect(accepted.status, accepted.text).toBe(200);
      expect(accepted.body.pendingMemberships).toEqual([]);
      expect(accepted.body.orgs.map((o) => o.id).sort()).toEqual(['home', 'other']);
      expect((await dinaClient.post('/api/v1/me/memberships/other/decline')).status).toBe(404);
      expect((await dinaClient.put('/api/v1/me/org', { org: 'other' })).status).toBe(200);
    });
  });

  describe('declining an invitation', () => {
    let eko: Person;
    let ekoClient: Client;

    beforeAll(async () => {
      eko = await addPerson(db, 'eko', [{ org: home }, { org: other, status: 'invited', invitedBy: otherAdmin.id }]);
      ekoClient = await sessionIn(full, eko.id, home);
    });

    it('removes the invited membership, audits membership.declined and answers 404 afterwards', async () => {
      expect((await me(ekoClient)).pendingMemberships).toEqual([expect.objectContaining({ org: 'other', invitedBy: otherAdmin.displayName })]);
      const declined = await callRoute(ekoClient, route('me.membership.decline'), { params: { org: 'other' } });
      expect(declined.violations).toEqual([]);
      expect(declined.status, declined.text).toBe(204);
      expect((await me(ekoClient)).pendingMemberships).toEqual([]);

      const row = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select(['status', 'deleted_at']).where('user_id', '=', eko.id).where('organization_id', '=', other.id).executeTakeFirstOrThrow(),
      );
      expect(row.deleted_at).not.toBeNull();
      expect(await platformAudit(db, 'membership.declined')).toEqual([
        expect.objectContaining({ organization_id: other.id, actor_kind: 'user', actor_user_id: eko.id, entity_id: eko.id }),
      ]);

      expect((await ekoClient.post('/api/v1/me/memberships/other/decline')).status).toBe(404);
      expect((await ekoClient.post('/api/v1/me/memberships/other/accept')).status).toBe(404);
      // An active membership and an unknown organisation are not declinable.
      expect((await ekoClient.post('/api/v1/me/memberships/home/decline')).status).toBe(404);
      expect((await ekoClient.post('/api/v1/me/memberships/nowhere/decline')).status).toBe(404);
      expect((await ekoClient.put('/api/v1/me/org', { org: 'other' })).status).toBe(404);
    });

    it('lets the organisation invite the account again after a decline', async () => {
      const again = await otherTa.post('/api/v1/admin/users', { email: eko.email, displayName: eko.displayName, adminRoles: [] });
      expect(again.status, again.text).toBe(202);
      // The membership row is the one declined before (its created_at is older); the time shown is the new invitation's.
      const invitedAt = await invitedEntryAt(db, other.id, eko.id);
      const row = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.org_membership').select('created_at').where('user_id', '=', eko.id).where('organization_id', '=', other.id).executeTakeFirstOrThrow(),
      );
      expect(new Date(row.created_at).toISOString() < invitedAt).toBe(true);
      expect((await me(ekoClient)).pendingMemberships).toEqual([expect.objectContaining({ org: 'other', invitedAt })]);
    });
  });

  describe('recovery codes and the security overview (D.1)', () => {
    let fajar: Person;
    let secret: Buffer;
    const OLD = ['old1-code-aa', 'old2-code-bb'];

    const regenerate = (client: Client, body: unknown) => callRoute<RecoveryCodesResponse>(client, route('me.recovery-codes'), { body });
    const secondFactor = (userId: string, proof: { code: string } | { recoveryCode: string }) =>
      full.get<TenantScope>(TenantScope).withPlatform((trx) => full.get<MfaService>(MfaService).checkSecondFactor(trx, userId, proof, { organizationId: home.id }), {
        scope: 'auth',
        userId,
      });
    const security = async (client: Client): Promise<MeSecurity> => {
      const call = await callRoute<MeSecurity>(client, route('me.security'), {});
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(200);
      expect(MeSecurity.safeParse(call.body).success).toBe(true);
      return call.body;
    };

    beforeAll(async () => {
      fajar = await addPerson(db, 'fajar', [{ org: home }], { password: true });
      secret = await addFactor(fajar.id);
      const hashes = await Promise.all(OLD.map((c) => hashSecret(recoveryCodeKey(c))));
      await inPlatform(db, (trx) => trx.insertInto('platform.mfa_recovery_code').values(hashes.map((code_hash) => ({ user_id: fajar.id, code_hash }))).execute());
      await mail.clear();
    });

    it('shows the security overview: password, authenticator, codes left and linked identities', async () => {
      const providerId = await inPlatform(db, async (trx) => {
        const row = await trx
          .insertInto('platform.identity_provider')
          .values({ organization_id: home.id, slug: 'entra', kind: 'oidc', display_name: 'Sign in with Entra', oidc_issuer: 'https://login.example.test/v2.0', oidc_client_id: 'mscd' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('platform.user_identity').values({ identity_provider_id: row.id, subject: 'fajar-sub', user_id: fajar.id, link_method: 'admin' }).execute();
        return row.id;
      });
      expect(providerId).toBeTruthy();
      const client = await sessionIn(full, fajar.id, home);
      expect(await security(client)).toEqual({
        passwordSet: true,
        ssoOnly: false,
        authenticatorSetUpAt: expect.any(String),
        recoveryCodesLeft: 2,
        identities: [{ provider: 'entra', kind: 'oidc', label: 'Sign in with Entra', linkedAt: expect.any(String) }],
      });

      // An account whose only organisation refuses local sign-in signs in through a provider only.
      const ssoOrg = await createTenant(db, 'ssoonly', { name: 'PT SSO Only' });
      await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ local_login: 'disabled' }).where('id', '=', ssoOrg.id).execute());
      const sso = await addPerson(db, 'sso.person', [{ org: ssoOrg }]);
      expect(await security(await sessionIn(full, sso.id, ssoOrg))).toEqual({
        passwordSet: false,
        ssoOnly: true,
        authenticatorSetUpAt: null,
        recoveryCodesLeft: 0,
        identities: [],
      });
    });

    it('asks for the authenticator code without a recent proof and counts a wrong code', async () => {
      const stale = await sessionIn(full, fajar.id, home, { mfaAt: new Date(Date.now() - 10 * 60_000) });
      const required = await regenerate(stale, {});
      expect(required.violations).toEqual([]);
      expect(required.status).toBe(422);
      expect(required.text).toContain('auth.proof_required');
      const wrong = await regenerate(stale, { code: '000000' });
      expect(wrong.status).toBe(422);
      expect(wrong.text).toContain('auth.proof_invalid');
      const user = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('mfa_failed_count').where('id', '=', fajar.id).executeTakeFirstOrThrow());
      expect(user.mfa_failed_count).toBe(1);
      expect(await platformAudit(db, 'auth.recovery_codes_regenerated')).toEqual([]);
    });

    it('gives ten new codes for the current code; the old ones stop working; audited and emailed', async () => {
      const stale = await sessionIn(full, fajar.id, home, { mfaAt: new Date(Date.now() - 10 * 60_000) });
      const code = totpAt(secret, full.get<Clock>(Clock).now().getTime());
      const fresh = await regenerate(stale, { code });
      expect(fresh.violations).toEqual([]);
      expect(fresh.status, fresh.text).toBe(200);
      expect(fresh.headers['cache-control']).toContain('no-store');
      const codes = fresh.body.codes;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      expect(codes.some((c) => OLD.includes(c))).toBe(false);

      // The old codes no longer pass the second-factor check; a new one does, once.
      expect((await secondFactor(fajar.id, { recoveryCode: OLD[0]! })).kind).toBe('failed');
      expect(await secondFactor(fajar.id, { recoveryCode: codes[0]! })).toEqual({ kind: 'ok', method: 'recovery_code' });
      expect((await secondFactor(fajar.id, { recoveryCode: codes[0]! })).kind).toBe('failed');

      expect(await platformAudit(db, 'auth.recovery_codes_regenerated')).toEqual([
        expect.objectContaining({ actor_kind: 'user', actor_user_id: fajar.id, entity_id: fajar.id, organization_id: home.id, after_data: { recoveryCodes: 10, replacedUnused: 2 } }),
      ]);
      const notice = await mail.waitFor(fajar.email, (m) => m.mailKind === 'security:recovery_codes_regenerated');
      expect(notice.text).toContain('The old codes no longer work');
      expect(notice.text).not.toContain(codes[1]!);
      // The authenticator stays; the codes are stored as hashes only.
      const stored = await inPlatform(db, (trx) =>
        trx.selectFrom('platform.mfa_recovery_code').select('code_hash').where('user_id', '=', fajar.id).where('deleted_at', 'is', null).execute(),
      );
      expect(stored).toHaveLength(10);
      expect(stored.every((r) => !codes.some((c) => r.code_hash.includes(c)))).toBe(true);
      expect((await security(stale)).recoveryCodesLeft).toBe(9);
    });

    it('needs no code right after a proof of the second factor, and answers 409 without an authenticator', async () => {
      const recent = await sessionIn(full, fajar.id, home);
      const again = await regenerate(recent, {});
      expect(again.status, again.text).toBe(200);
      expect((await platformAudit(db, 'auth.recovery_codes_regenerated')).at(-1)?.after_data).toEqual({ recoveryCodes: 10, replacedUnused: 9 });

      const plain = await addPerson(db, 'no.factor', [{ org: home }], { password: true });
      const refused = await regenerate(await sessionIn(full, plain.id, home), {});
      expect(refused.violations).toEqual([]);
      expect(refused.status).toBe(409);
      expect(refused.text).toContain('auth.no_authenticator');
    });
  });

  describe('POST /notifications/read-all', () => {
    it('marks every notification of the session user read and leaves other people alone', async () => {
      const gita = await addPerson(db, 'gita', [{ org: home }]);
      const hadi = await addPerson(db, 'hadi', [{ org: home }]);
      const insert = (userId: string, title: string) =>
        inTenant(db, home, (trx) =>
          trx
            .insertInto('notification')
            .values({ recipient_user_id: userId, kind: 'reminder', title_en: title, title_id: title, body_en: title, body_id: title, digest: false, email_status: 'skipped' })
            .execute(),
        );
      await insert(gita.id, 'One');
      await insert(gita.id, 'Two');
      await insert(hadi.id, 'Three');
      const client = await sessionIn(full, gita.id, home);
      const unread = async () => (await client.get<{ total: number }>('/api/v1/notifications?unread=true')).body.total;
      expect(await unread()).toBe(2);
      const call = await callRoute(client, route('notifications.read-all'), {});
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(204);
      expect(await unread()).toBe(0);
      // Again: nothing left, still 204.
      expect((await client.post('/api/v1/notifications/read-all')).status).toBe(204);
      const hadiRows = await inTenant(db, home, (trx) => trx.selectFrom('notification').select('read_at').where('recipient_user_id', '=', hadi.id).execute());
      expect(hadiRows).toEqual([{ read_at: null }]);
    });
  });
});
