// A person erased in an organisation and invited there again (Milestone 3 H.13, decided by the product owner on
// 2026-11-01; built by the M3-04 follow-up). The person rejoins with a fresh account and membership with a new user id;
// the erased account, its removed membership, its pseudonym (`erased_person`) and every record from before the erasure
// stay as they were, and the new account is an ordinary member with no link to the pseudonym. Three cases:
//   - the erased account was anonymised (no other membership): the invitation of the same email address creates a fresh
//     account, which accepts the invitation and signs in;
//   - the erased account is kept for another organisation: the same email address is refused (422
//     `invitation.erased_person`, on `POST /admin/users` and on the operator's path alike) without any change, the
//     account keeps working in its other organisation, and an invitation with another email address gives the fresh
//     account;
//   - the erased account was kept, but its other membership has ended since: the invitation anonymises it, as step 5 of
//     the erasure would have done, and creates a fresh account with the same email address.
// The people are invented (R-19).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandResult, Page, UserView } from '@mscd/shared';
import { InvitationService, type CreatedInvitation } from '../../../src/modules/identity/invitation.service';
import { pseudonymHandle } from '../../../src/modules/privacy/pseudonym';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import {
  APP_ORIGIN, createPrivacyApp, inventedMember, ORG_IDS, platformRows, primaryManagers, rowsOf, signIn, type Client, type DemoOrg, type PrivacyApp,
} from './helpers';

const REQUESTS = '/api/v1/admin/privacy-requests';
const REQUEST = (id: string) => `${REQUESTS}/${id}`;
const CHECKS = (ms: string) => `/api/v1/ms/${ms}/privacy-checks`;
const USERS = '/api/v1/admin/users';
const ORG: DemoOrg = 'ndt';
const PASSWORD = 'Rejoin-Fresh-Passphrase-58';

interface AccountRow {
  id: string;
  handle: string;
  email: string;
  display_name: string;
  status: string;
  erased_at: Date | null;
}

describe('a person erased in an organisation and invited again (H.13)', () => {
  const db = useTestDatabase('demo');
  let ctx: PrivacyApp;
  let rina: Client;
  let managers: Map<string, string | null>;
  const clients = new Map<string, Client>();
  /** Every invitation link written while the tests run (the token is shown once, so the tests read it here). */
  const issued: { userId: string; orgId: string; invitation: CreatedInvitation }[] = [];

  const as = async (handle: string, org: DemoOrg = ORG): Promise<Client> => {
    const key = `${handle}@${org}`;
    let client = clients.get(key);
    if (!client) {
      client = await signIn(ctx, db, handle, org);
      clients.set(key, client);
    }
    return client;
  };

  /** Records, starts, checks and carries out an erasure of a member of ndt; answers the pseudonym and the counts. */
  const erase = async (user: string): Promise<{ pseudonym: string; counts: Record<string, number> }> => {
    const created = await rina.post<CommandResult>(REQUESTS, { type: 'erasure', subject: { userId: user }, receivedAt: new Date().toISOString(), channel: 'email' });
    expect(created.status, created.text).toBe(201);
    const id = (created.body.data as { id: string }).id;
    const started = await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Identity checked by a video call' });
    expect(started.status, started.text).toBe(200);
    const detail = await rina.get<{ checks: { id: string; ms: string }[] }>(REQUEST(id));
    for (const check of detail.body.checks) {
      const manager = await as(managers.get(check.ms)!);
      const done = await manager.post(`${CHECKS(check.ms)}/${check.id}/done`, { note: 'Records checked; nothing to change' });
      expect(done.status, done.text).toBe(200);
    }
    const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
    expect(erased.status, erased.text).toBe(200);
    const [row] = await rowsOf<{ pseudonym: string }>(db, ORG, sql`select pseudonym from erased_person where erased_user_id = ${user}::uuid`);
    return { pseudonym: row!.pseudonym, counts: erased.body.data as Record<string, number> };
  };

  /** An ISMS activity marked done by the person (a record that names them), picked by its place in the plan. */
  const completeActivity = async (user: string, place: number): Promise<string> => {
    const [row] = await rowsOf<{ id: string }>(db, ORG, sql`
      update implementation_activity_progress set status = 'verified', completed_by_user_id = ${user}::uuid, completed_at = now(), verified_at = now()
       where id = (select a.id from implementation_activity_progress a join management_system m on m.id = a.management_system_id
                    where m.slug = 'isms' and a.deleted_at is null order by a.phase_no, a.activity_no offset ${place} limit 1)
      returning id`);
    return row!.id;
  };

  const accounts = (email: string) =>
    platformRows<AccountRow>(db, sql`
      select id, handle, email, display_name, status, erased_at from platform.app_user where lower(email) = lower(${email}) order by created_at`);
  const account = async (id: string) =>
    (await platformRows<AccountRow>(db, sql`select id, handle, email, display_name, status, erased_at from platform.app_user where id = ${id}::uuid`))[0]!;
  const membership = async (org: DemoOrg, user: string) =>
    (await platformRows<{ status: string; deleted_at: Date | null }>(db, sql`
      select status, deleted_at from platform.org_membership where organization_id = ${ORG_IDS[org]}::uuid and user_id = ${user}::uuid`))[0];
  const erasedRows = () => rowsOf<{ erased_user_id: string; pseudonym: string; deleted_at: Date | null }>(db, ORG, sql`
    select erased_user_id, pseudonym, deleted_at from erased_person order by erased_user_id`);
  const tokenFor = (user: string): string => {
    const found = issued.filter((i) => i.userId === user && i.orgId === ORG_IDS[ORG]).at(-1);
    expect(found, `an invitation link for ${user}`).toBeDefined();
    return found!.invitation.token;
  };
  /** An anonymous browser call (no session), as the invitation page and the sign-in page make it. */
  const anonymous = async (url: string, payload: unknown) => {
    const response = await ctx.app.inject({ method: 'POST', url, headers: { origin: APP_ORIGIN }, payload: payload as Record<string, unknown> });
    return { status: response.statusCode, body: response.json() as Record<string, unknown>, text: response.body };
  };
  /** Accepts the invitation of a fresh account with a new password, then signs in with the email address. */
  const acceptAndSignIn = async (user: string, email: string): Promise<void> => {
    const accepted = await anonymous('/api/v1/auth/invitations/accept', { token: tokenFor(user), password: PASSWORD });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.status).toBe('mfa_enrolment_required');
    expect(await membership(ORG, user)).toMatchObject({ status: 'active', deleted_at: null });
    const login = await anonymous('/api/v1/auth/login', { email, password: PASSWORD, remember: false });
    expect(login.status, login.text).toBe(200);
    expect(login.body.status).toBe('mfa_enrolment_required');
    const sessions = await platformRows<{ organization_id: string }>(db, sql`
      select organization_id from platform.session where user_id = ${user}::uuid and revoked_at is null`);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.organization_id === ORG_IDS[ORG])).toBe(true);
  };
  /** What ndt shows of the fresh account and of the pseudonym after the person rejoined. */
  const expectOrdinaryMember = async (fresh: { id: string; handle: string; name: string; email: string }, erased: { id: string; pseudonym: string; activity: string }) => {
    const handle = pseudonymHandle(erased.pseudonym);
    // People and roles: the fresh account under its own name; the erased account is not listed and no row carries the
    // pseudonym.
    const users = await rina.get<Page<UserView>>(`${USERS}?pageSize=200`);
    expect(users.status, users.text).toBe(200);
    expect(users.body.items.filter((u) => u.id === fresh.id)).toMatchObject([{ handle: fresh.handle, displayName: fresh.name, email: fresh.email, membershipStatus: 'active' }]);
    expect(users.body.items.map((u) => u.id)).not.toContain(erased.id);
    expect(JSON.stringify(users.body)).not.toContain(erased.pseudonym);
    // The fresh account works under its own name: its own audit entry shows it, and its own requests do not list the
    // erasure request of the erased account.
    const member = await as(fresh.handle);
    expect((await member.patch('/api/v1/me/profile', { jobTitle: 'Planner' })).status).toBe(204);
    const trail = await rina.get<Page<{ action: string; actor: { handle: string | null; displayName: string | null } }>>(`/api/v1/admin/audit-trail?entityId=${fresh.id}&pageSize=200`);
    expect(trail.status, trail.text).toBe(200);
    expect(trail.body.items.find((e) => e.action === 'user.updated')?.actor).toEqual(expect.objectContaining({ handle: fresh.handle, displayName: fresh.name }));
    expect(JSON.stringify(trail.body)).not.toContain(erased.pseudonym);
    const mine = await member.get<unknown[]>('/api/v1/me/privacy-requests');
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body).toEqual([]);
    // The records from before the erasure keep the pseudonym and stay with the erased account.
    await rowsOf(db, ORG, sql`
      insert into user_ms_role (management_system_id, user_id, role, is_primary, approval_status)
      select m.id, ${fresh.id}::uuid, 'domain_owner', false, 'active' from management_system m where m.slug = 'isms' returning id`);
    const org = await rina.get<{ PEOPLE: Record<string, [string, string]> }>('/api/v1/ui/org');
    expect(org.status, org.text).toBe(200);
    expect(org.body.PEOPLE[handle]).toEqual([erased.pseudonym, 'Former member']);
    expect(org.body.PEOPLE[fresh.handle]).toEqual([fresh.name, 'Planner']);
    const [activity] = await rowsOf<{ completed_by_user_id: string }>(db, ORG, sql`
      select completed_by_user_id from implementation_activity_progress where id = ${erased.activity}::uuid`);
    expect(activity!.completed_by_user_id).toBe(erased.id);
    const isms = await rina.get('/api/v1/ui/ms/isms');
    expect(isms.status, isms.text).toBe(200);
    expect(isms.text).toContain(`"by":"${handle}"`);
    const before = await rina.get<Page<{ actor: { handle: string | null; displayName: string | null } }>>(`/api/v1/admin/audit-trail?entityId=${erased.id}&pageSize=200`);
    expect(before.status, before.text).toBe(200);
    for (const entry of before.body.items) {
      expect(entry.actor.handle).not.toBe(fresh.handle);
      expect(entry.actor.displayName).not.toBe(fresh.name);
    }
  };

  beforeAll(async () => {
    ctx = await createPrivacyApp(db);
    rina = await as('rina');
    managers = await primaryManagers(db, ORG);
    const invitations = ctx.moduleRef.get(InvitationService);
    const original = invitations.createInvitation.bind(invitations);
    vi.spyOn(invitations, 'createInvitation').mockImplementation(async (trx, input) => {
      const invitation = await original(trx, input);
      issued.push({ userId: input.userId, orgId: input.orgId, invitation });
      return invitation;
    });
  }, 240_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  it('gives a person whose account was anonymised a fresh account with the same email address', async () => {
    const email = 'laras.wibowo@nusantaradigital.co.id';
    const old = await inventedMember(db, ORG, { handle: 'laras.wibowo', displayName: 'Laras Wibowo', email, jobTitle: 'Analyst', role: 'domain_owner' });
    const activity = await completeActivity(old, 0);
    const { pseudonym, counts } = await erase(old);
    expect(counts).toMatchObject({ erased: 1, accountAnonymised: 1 });
    const erasedBefore = await erasedRows();

    const invited = await rina.post(USERS, { email, displayName: 'Laras Wibowo', jobTitle: 'Analyst', adminRoles: [] });
    expect(invited.status, invited.text).toBe(202);
    const [fresh, ...others] = await accounts(email);
    expect(others).toEqual([]);
    expect(fresh!.id).not.toBe(old);
    expect(fresh).toMatchObject({ handle: 'laras.wibowo', display_name: 'Laras Wibowo', status: 'invited', erased_at: null });
    expect(await membership(ORG, fresh!.id)).toMatchObject({ status: 'invited', deleted_at: null });
    // The erased identity stays as it was: anonymised, its membership removed, its pseudonym unchanged.
    expect((await account(old)).handle).toMatch(/^erased-[0-9a-f]{8}$/);
    expect((await membership(ORG, old))!.deleted_at).not.toBeNull();
    expect(await erasedRows()).toEqual(erasedBefore);
    expect(erasedBefore.find((r) => r.erased_user_id === old)).toMatchObject({ pseudonym, deleted_at: null });

    await acceptAndSignIn(fresh!.id, email);
    await expectOrdinaryMember({ id: fresh!.id, handle: 'laras.wibowo', name: 'Laras Wibowo', email }, { id: old, pseudonym, activity });
  });

  it('refuses the email address of an account kept for another organisation, and gives a fresh account under another address', async () => {
    const email = 'dimas.pratama@nusantaradigital.co.id';
    const kept = await inventedMember(db, ORG, { handle: 'dimas.pratama', displayName: 'Dimas Pratama', email, jobTitle: 'Engineer', role: 'domain_owner' });
    await platformRows(db, sql`
      insert into platform.org_membership (organization_id, user_id, status, admin_roles) values (${ORG_IDS.bsd}::uuid, ${kept}::uuid, 'active', '{}') returning user_id`);
    const activity = await completeActivity(kept, 1);
    const { pseudonym, counts } = await erase(kept);
    expect(counts).toMatchObject({ erased: 1, accountAnonymised: 0 });
    const erasedBefore = await erasedRows();
    const accountBefore = await account(kept);

    // POST /admin/users: refused with the reason, nothing written.
    const refused = await rina.post(USERS, { email: email.toUpperCase(), displayName: 'Dimas Pratama', adminRoles: [] });
    expect(refused.status, refused.text).toBe(422);
    expect(refused.body).toMatchObject({ messageKey: 'invitation.erased_person', messages: { en: expect.stringMatching(/different email address/), id: expect.stringMatching(/alamat email lain/) } });
    // The operator's path (`admin create-user`, the first admin of a new organisation) refuses it the same way.
    const operator = ctx.moduleRef.get(TenantScope).withPlatform(
      (trx) => ctx.moduleRef.get(InvitationService).inviteUser(trx, { orgId: ORG_IDS[ORG], email, actor: { userId: null, kind: 'operator' }, linkForActiveAccount: true }),
      { scope: 'cli', orgId: ORG_IDS[ORG] },
    );
    await expect(operator).rejects.toMatchObject({ status: 422, extras: { messageKey: 'invitation.erased_person' } });
    expect(await account(kept)).toEqual(accountBefore);
    expect(accountBefore).toMatchObject({ handle: 'dimas.pratama', status: 'active', erased_at: null });
    expect(await membership(ORG, kept)).toMatchObject({ deleted_at: expect.any(Date) });
    expect(await membership('bsd', kept)).toMatchObject({ status: 'active', deleted_at: null });
    expect(await erasedRows()).toEqual(erasedBefore);
    const links = await platformRows<{ n: number }>(db, sql`
      select count(*)::int as n from platform.invitation where user_id = ${kept}::uuid and organization_id = ${ORG_IDS[ORG]}::uuid`);
    expect(links[0]!.n).toBe(0);
    // The account keeps working in its other organisation, under its name there.
    const elsewhere = await as('dimas.pratama', 'bsd');
    expect((await elsewhere.get('/api/v1/me/privacy-requests')).status).toBe(200);
    const bsdUsers = await (await as('rina', 'bsd')).get<Page<UserView>>(`${USERS}?q=dimas`);
    expect(bsdUsers.body.items.map((u) => [u.handle, u.displayName])).toEqual([['dimas.pratama', 'Dimas Pratama']]);

    // Another email address gives the fresh account.
    const other = 'dimas.pratama@mail.example';
    const invited = await rina.post(USERS, { email: other, displayName: 'Dimas Pratama', adminRoles: [] });
    expect(invited.status, invited.text).toBe(202);
    const [fresh, ...more] = await accounts(other);
    expect(more).toEqual([]);
    expect(fresh!.id).not.toBe(kept);
    expect(fresh).toMatchObject({ handle: 'dimas.pratama-2', status: 'invited', erased_at: null });
    await acceptAndSignIn(fresh!.id, other);
    await expectOrdinaryMember({ id: fresh!.id, handle: 'dimas.pratama-2', name: 'Dimas Pratama', email: other }, { id: kept, pseudonym, activity });
    // The kept account is still no member of ndt and still a member of bsd.
    expect((await membership(ORG, kept))!.deleted_at).not.toBeNull();
    expect(await membership('bsd', kept)).toMatchObject({ status: 'active', deleted_at: null });
    expect((await elsewhere.get('/api/v1/me/privacy-requests')).status).toBe(200);
  });

  it('anonymises an account kept for a membership that has ended since, and gives a fresh account with the same email address', async () => {
    const email = 'sekar.ayu@nusantaradigital.co.id';
    const kept = await inventedMember(db, ORG, { handle: 'sekar.ayu', displayName: 'Sekar Ayu', email, jobTitle: 'Coordinator', role: 'domain_owner' });
    await platformRows(db, sql`
      insert into platform.org_membership (organization_id, user_id, status, admin_roles) values (${ORG_IDS.bsd}::uuid, ${kept}::uuid, 'active', '{}') returning user_id`);
    const { pseudonym, counts } = await erase(kept);
    expect(counts).toMatchObject({ erased: 1, accountAnonymised: 0 });
    // The person leaves the other organisation later.
    await platformRows(db, sql`
      update platform.org_membership set deleted_at = now() where organization_id = ${ORG_IDS.bsd}::uuid and user_id = ${kept}::uuid returning user_id`);
    const erasedBefore = await erasedRows();

    const invited = await rina.post(USERS, { email, displayName: 'Sekar Ayu', adminRoles: [] });
    expect(invited.status, invited.text).toBe(202);
    const anonymised = await account(kept);
    expect(anonymised.handle).toMatch(/^erased-[0-9a-f]{8}$/);
    expect(anonymised).toMatchObject({ email: `${anonymised.handle}@erased.invalid`, display_name: 'Former user', status: 'disabled' });
    expect(anonymised.erased_at).not.toBeNull();
    const audit = await platformRows<{ organization_id: string; actor_user_id: string; entity_code: string; after_data: { reason: string } }>(db, sql`
      select organization_id, actor_user_id, entity_code, after_data from platform.audit_log where action = 'user.anonymised' and entity_id = ${kept}::uuid`);
    expect(audit).toEqual([{ organization_id: ORG_IDS[ORG], actor_user_id: rina.userId, entity_code: anonymised.handle, after_data: expect.objectContaining({ reason: expect.stringMatching(/invited again/) }) }]);
    const [fresh, ...others] = await accounts(email);
    expect(others).toEqual([]);
    expect(fresh!.id).not.toBe(kept);
    expect(fresh).toMatchObject({ handle: 'sekar.ayu', display_name: 'Sekar Ayu', status: 'invited', erased_at: null });
    expect(await membership(ORG, fresh!.id)).toMatchObject({ status: 'invited', deleted_at: null });
    expect((await membership(ORG, kept))!.deleted_at).not.toBeNull();
    expect(await erasedRows()).toEqual(erasedBefore);
    expect(erasedBefore.find((r) => r.erased_user_id === kept)).toMatchObject({ pseudonym, deleted_at: null });
    await acceptAndSignIn(fresh!.id, email);
  });
});
