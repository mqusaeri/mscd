// Idempotency keys of the platform operator (Milestone 2 M2-19 follow-up 8, Milestone 3 M3-12): an operator has no
// organisation, so the keys are kept by user under PLATFORM_IDEMPOTENCY_ORG. A retried `POST /ops/organizations` and a
// retried account action replay the first answer and run once; another body with the same key is refused; another
// operator's key is their own; and an organisation's keys never see the operator's.
// With mail off and mail.required false (the on-premise default) those answers carry a one-time link once. The stored
// answer never holds it: a replay answers 2xx without the link and says how to get a new one, the command still ran
// once, and the link of the first answer is the one that works. Every idempotent route whose answer type has a link
// member is listed in ONE_TIME_SECRET_MEMBERS.
import { API_ROUTES, type OpsAccountActionResult, type OpsOperatorAddResult, type OpsOrganizationCreateResult } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { sha256 } from '../../../src/modules/identity/tokens';
import { ONE_TIME_SECRET_MEMBERS, idempotentBodyToStore } from '../../../src/modules/tenancy/idempotency-secrets';
import { PLATFORM_IDEMPOTENCY_ORG } from '../../../src/modules/tenancy/idempotency-store';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, createOnboardingApp, inPlatform, platformAudit, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import { ADD_OPERATOR, PASSWORD_RESET, RESEND, auditAbout, call, sessionsOf } from './accounts-helpers';

const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
const CREATE = route('ops.organizations.create');
const REVOKE = route('ops.accounts.sessions-revoke');
const MULTI = { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' };
const REASON = 'Asked by the Tenant Admin in ticket 5120';

const organisation = (slug: string, email: string) => ({
  slug,
  name: `PT ${slug.replace(/_/g, ' ')}`,
  timeZone: 'Asia/Jakarta',
  siteCount: 1,
  firstAdmin: { email, displayName: `Admin of ${slug}` },
});

describe('idempotency keys of the platform operator (M2-19 follow-up 8, M3-12)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let home: CreatedTenant;
  let operator: Person;
  let second: Person;
  let rina: Person;
  let op: Client;
  let op2: Client;

  const storedKeys = (orgId: string) =>
    inScope(db.migrator, { orgId }, (trx) =>
      trx.selectFrom('platform.idempotency_key').select(['organization_id', 'user_id', 'key', 'route', 'status']).orderBy('key').execute(),
    );
  const organisations = (slug: string) =>
    inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('id').where('slug', '=', slug).execute());

  beforeAll(async () => {
    mail = await startMailpit();
    home = await createTenant(db, 'home', { name: 'PT Home' });
    operator = await addPerson(db, 'ops.idem', [], { platformOperator: true, password: true });
    second = await addPerson(db, 'ops.idem.two', [], { platformOperator: true, password: true });
    rina = await addPerson(db, 'rina.idem', [{ org: home, adminRoles: ['tenant_admin'] }], { password: true });
    full = await createOnboardingApp(db, { mail, env: MULTI });
    op = await sessionIn(full, operator.id, null);
    op2 = await sessionIn(full, second.id, null);
  });
  afterAll(async () => {
    await full?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('replays POST /ops/organizations for the same key and body, so a retry creates no second organisation', async () => {
    const body = organisation('idem_bank', 'andi@idembank.test');
    const first = await callRoute<OpsOrganizationCreateResult>(op, CREATE, { body, headers: { 'idempotency-key': 'ops-create-0001' } });
    expect(first.violations).toEqual([]);
    expect(first.status, first.text).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const retried = await callRoute<OpsOrganizationCreateResult>(op, CREATE, { body, headers: { 'idempotency-key': 'ops-create-0001' } });
    expect(retried.violations).toEqual([]);
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.body).toEqual(first.body);
    expect(await organisations('idem_bank')).toEqual([{ id: first.body.data.id }]);
    expect((await platformAudit(db, 'ops.organization_created')).filter((e) => e.entity_code === 'idem_bank')).toHaveLength(1);

    // The key is the operator's, under the platform id, with the stored answer.
    expect(await storedKeys(PLATFORM_IDEMPOTENCY_ORG)).toEqual([
      { organization_id: PLATFORM_IDEMPOTENCY_ORG, user_id: operator.id, key: 'ops-create-0001', route: 'ops.organizations.create', status: 201 },
    ]);
  });

  it('refuses the same key with another body (409 idempotency.key_reused) and creates nothing', async () => {
    const reused = await callRoute(op, CREATE, { body: organisation('idem_other', 'sari@idemother.test'), headers: { 'idempotency-key': 'ops-create-0001' } });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ messageKey: 'idempotency.key_reused' });
    expect(await organisations('idem_other')).toEqual([]);
  });

  it("keeps each operator's keys apart: another operator's request with the same key runs", async () => {
    // The same key and body as the first test: not a replay, so the command runs and meets the existing organisation.
    const other = await callRoute(op2, CREATE, { body: organisation('idem_bank', 'andi@idembank.test'), headers: { 'idempotency-key': 'ops-create-0001' } });
    expect(other.status).toBe(409);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(other.body).toMatchObject({ messageKey: 'org_exists' });
    expect(await organisations('idem_bank')).toHaveLength(1);
    // A refused command releases its key, so only the first operator's key is stored.
    expect((await storedKeys(PLATFORM_IDEMPOTENCY_ORG)).map((k) => k.user_id)).toEqual([operator.id]);
  });

  it('replays an account action (POST /ops/accounts/{id}/sessions/revoke) once, so a retry ends no newer session', async () => {
    await sessionIn(full, rina.id, home);
    const before = (await sessionsOf(db, rina.id)).open;
    expect(before).toBeGreaterThan(0);
    const input = { params: { id: rina.id }, body: { reason: REASON }, headers: { 'idempotency-key': 'ops-revoke-0001' } };
    const first = await callRoute<OpsAccountActionResult>(op, REVOKE, input);
    expect(first.violations).toEqual([]);
    expect(first.status, first.text).toBe(200);
    expect(first.body.data).toMatchObject({ id: rina.id, sessionsRevoked: before });
    expect((await sessionsOf(db, rina.id)).open).toBe(0);

    // Rina signs in again; the retried request answers as before and leaves the new session open.
    await sessionIn(full, rina.id, home);
    const retried = await callRoute<OpsAccountActionResult>(op, REVOKE, input);
    expect(retried.status).toBe(200);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.body).toEqual(first.body);
    expect((await sessionsOf(db, rina.id)).open).toBe(1);
    expect(await auditAbout(db, rina.id, 'auth.session_revoked')).toHaveLength(1);
  });

  it("never shows the operator's keys in an organisation's scope, nor an organisation's keys under the platform id", async () => {
    const inHome = await storedKeys(home.id);
    expect(inHome.filter((k) => k.organization_id !== home.id)).toEqual([]);
    expect(inHome.map((k) => k.key)).not.toContain('ops-create-0001');
    expect((await storedKeys(PLATFORM_IDEMPOTENCY_ORG)).every((k) => k.organization_id === PLATFORM_IDEMPOTENCY_ORG)).toBe(true);
    expect((await storedKeys(PLATFORM_IDEMPOTENCY_ORG)).map((k) => k.key)).toEqual(['ops-create-0001', 'ops-revoke-0001']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// One-time links (M3-12): mail off and mail.required false
// ---------------------------------------------------------------------------------------------------------------

/** The token of a one-time link (`.../reset-password#token=...`, `.../invite#token=...`). */
const tokenOf = (link: string | undefined): string => {
  const token = /#token=([A-Za-z0-9_-]+)$/.exec(link ?? '')?.[1];
  if (!token) throw new Error(`no token in ${String(link)}`);
  return token;
};

/** An answer's data without the one-time link and its expiry, as a replay answers it. */
const withoutLink = <T extends { link?: string; expiresAt?: string }>(data: T): Omit<T, 'link' | 'expiresAt'> => {
  const { link: _link, expiresAt: _expiresAt, ...rest } = data;
  return rest;
};

describe('one-time links in the stored answers of operator commands (M3-12, mail off)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let home: CreatedTenant;
  let operator: Person;
  let op: Client;

  /** The stored row of a key: its status and the stored answer as JSON text. */
  const stored = async (key: string) => {
    const row = await inScope(db.migrator, { orgId: PLATFORM_IDEMPOTENCY_ORG }, (trx) =>
      trx.selectFrom('platform.idempotency_key').select(['user_id', 'status', 'response']).where('key', '=', key).executeTakeFirstOrThrow(),
    );
    return { userId: row.user_id, status: row.status, text: JSON.stringify(row.response), response: row.response as { body: { message?: [string, string]; data: Record<string, unknown> } } };
  };
  /** The stored answer holds no address and no token. */
  const expectNoLink = (text: string) => {
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/token=/);
  };
  const unusedTokens = (userId: string, kind: 'reset' | 'set_password') =>
    inPlatform(db, (trx) =>
      trx.selectFrom('platform.password_reset_token').select('token_hash').where('user_id', '=', userId).where('kind', '=', kind).where('used_at', 'is', null).execute(),
    );
  const openInvitations = (userId: string) =>
    inPlatform(db, (trx) => trx.selectFrom('platform.invitation').select('token_hash').where('user_id', '=', userId).where('revoked_at', 'is', null).execute());
  const userByEmail = (email: string) =>
    inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', email).executeTakeFirstOrThrow());
  const organisations = (slug: string) =>
    inPlatform(db, (trx) => trx.selectFrom('platform.organization').select('id').where('slug', '=', slug).execute());
  const hashes = (rows: { token_hash: Uint8Array }[]) => rows.map((r) => Buffer.from(r.token_hash).toString('hex'));
  const hashOf = (token: string) => sha256(token).toString('hex');

  beforeAll(async () => {
    home = await createTenant(db, 'home', { name: 'PT Home' });
    operator = await addPerson(db, 'ops.idem.nomail', [], { platformOperator: true, password: true });
    full = await createOnboardingApp(db, { mail: null, env: MULTI });
    op = await sessionIn(full, operator.id, null);
  });
  afterAll(async () => {
    await full?.close();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
  });

  it('stores POST /ops/operators without the set-password link; the replay answers 201 without it, and adding again makes a new one', async () => {
    const body = { email: 'nomail.op@platform.test', name: 'No Mail Operator', reason: REASON };
    const input = { body, headers: { 'idempotency-key': 'nomail-operator-0001' } };
    const first = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, input);
    expect(first.status, first.text).toBe(201);
    expect(first.body.data).toMatchObject({ emailed: false, newAccount: true });
    const token = tokenOf(first.body.data.link);
    expect(first.body.data.expiresAt).toBeTruthy();

    const row = await stored('nomail-operator-0001');
    expect([row.userId, row.status]).toEqual([operator.id, 201]);
    expectNoLink(row.text);
    expect(row.text).not.toContain(token);
    expect(row.response.body.data).not.toHaveProperty('link');
    expect(row.response.body.data).not.toHaveProperty('expiresAt');

    const retried = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, input);
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.body.data).toEqual(withoutLink(first.body.data));
    expect(retried.body.message?.[0]).toBe(
      'nomail.op@platform.test is now a platform operator. The one-time link to set the password was shown only in the first answer and is not kept. To get a new link, add nomail.op@platform.test again: a new link is made and the earlier one stops working.',
    );
    expect(retried.body.message?.[1]).toContain('hanya ditampilkan pada jawaban pertama');

    // The command ran once, and the link of the first answer is the one that works.
    const user = await userByEmail(body.email);
    expect(hashes(await unusedTokens(user.id, 'set_password'))).toEqual([hashOf(token)]);
    expect((await platformAudit(db, 'ops.operator_created')).filter((e) => e.entity_id === user.id)).toHaveLength(1);

    // What the message says: adding the operator again makes a new link and ends the earlier one.
    const again = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, { body, headers: { 'idempotency-key': 'nomail-operator-0002' } });
    expect(again.status, again.text).toBe(201);
    const newer = tokenOf(again.body.data.link);
    expect(newer).not.toBe(token);
    expect(hashes(await unusedTokens(user.id, 'set_password'))).toEqual([hashOf(newer)]);
    expectNoLink((await stored('nomail-operator-0002')).text);
  });

  it('stores POST /ops/accounts/{id}/password-reset without the link; the replay answers 200 without it and makes no second link', async () => {
    const person = await addPerson(db, 'nomail.reset', [{ org: home }], { password: true });
    const input = { params: { id: person.id }, body: { reason: REASON }, headers: { 'idempotency-key': 'nomail-reset-0001' } };
    const first = await call<OpsAccountActionResult>(op, PASSWORD_RESET, input);
    expect(first.status, first.text).toBe(200);
    expect(first.body.data.emailed).toBe(false);
    const token = tokenOf(first.body.data.link);

    const row = await stored('nomail-reset-0001');
    expect(row.status).toBe(200);
    expectNoLink(row.text);
    expect(row.text).not.toContain(token);

    const retried = await call<OpsAccountActionResult>(op, PASSWORD_RESET, input);
    expect(retried.status).toBe(200);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.body.data).toEqual(withoutLink(first.body.data));
    expect(retried.body.data).toMatchObject({ id: person.id, emailed: false, status: 'active' });
    expect(retried.body.message?.[0]).toContain('was shown only in the first answer and is not kept');
    expect(retried.body.message?.[0]).toContain('"Send password link" again');

    expect(hashes(await unusedTokens(person.id, 'reset'))).toEqual([hashOf(token)]);
    expect(await auditAbout(db, person.id, 'auth.password_reset')).toHaveLength(1);
  });

  it('stores POST /ops/organizations and the invitation sent again without their invitation links', async () => {
    const body = organisation('nomail_bank', 'andi@nomailbank.test');
    const input = { body, headers: { 'idempotency-key': 'nomail-create-0001' } };
    const first = await call<OpsOrganizationCreateResult>(op, CREATE, input);
    expect(first.status, first.text).toBe(201);
    expect(first.body.data.invitationSent).toBe(false);
    const token = tokenOf(first.body.data.invitationUrl);

    const row = await stored('nomail-create-0001');
    expect(row.status).toBe(201);
    expectNoLink(row.text);
    expect(row.response.body.data).not.toHaveProperty('invitationUrl');

    const retried = await call<OpsOrganizationCreateResult>(op, CREATE, input);
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBe('true');
    expect(retried.body.data).toEqual({ id: first.body.data.id, slug: 'nomail_bank', invitationSent: false });
    expect(retried.body.message?.[0]).toContain('The slug nomail_bank cannot be changed.');
    expect(retried.body.message?.[0]).toContain('choose "Send invitation again"');
    expect(await organisations('nomail_bank')).toEqual([{ id: first.body.data.id }]);
    const admin = await userByEmail('andi@nomailbank.test');
    expect(hashes(await openInvitations(admin.id))).toEqual([hashOf(token)]);

    // What the message says: send the invitation again. Its link is not stored either.
    const resend = { params: { id: admin.id, org: 'nomail_bank' }, body: { reason: REASON }, headers: { 'idempotency-key': 'nomail-resend-0001' } };
    const sent = await call<OpsAccountActionResult>(op, RESEND, resend);
    expect(sent.status, sent.text).toBe(200);
    const newer = tokenOf(sent.body.data.link);
    expectNoLink((await stored('nomail-resend-0001')).text);
    const again = await call<OpsAccountActionResult>(op, RESEND, resend);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data).toEqual(withoutLink(sent.body.data));
    expect(again.body.message?.[0]).toContain('one-time invitation link was shown only in the first answer');
    expect(hashes(await openInvitations(admin.id))).toEqual([hashOf(newer)]);
  });
});

/** Dotted paths of the string members of an answer schema that can hold a link or a secret: a URL, or a telling name. */
function linkMembers(schema: unknown, path: string[] = [], depth = 0): string[] {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
  if (!def || depth > 10) return [];
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([name, member]) => {
        const here = [...path, name];
        const leaf = leafOf(member);
        const holdsSecret = leaf?.type === 'string' && (leaf.format === 'url' || SECRET_NAME.test(name));
        return [...(holdsSecret ? [here.join('.')] : []), ...linkMembers(member, here, depth + 1)];
      });
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
      return linkMembers(def.innerType, path, depth + 1);
    case 'pipe':
      return [...linkMembers(def.in, path, depth + 1), ...linkMembers(def.out, path, depth + 1)];
    case 'array':
      return linkMembers(def.element, [...path, '[]'], depth + 1);
    case 'record':
      return linkMembers(def.valueType, [...path, '*'], depth + 1);
    case 'union':
      return (def.options as unknown[]).flatMap((option) => linkMembers(option, path, depth + 1));
    case 'intersection':
      return [...linkMembers(def.left, path, depth + 1), ...linkMembers(def.right, path, depth + 1)];
    default:
      return [];
  }
}
/** Names of string members that can hold a secret (a boolean such as `clientSecretSet` cannot). */
const SECRET_NAME = /link|token|secret|password|invitationurl/i;
/** The definition under the optional, nullable and default wrappers of a member. */
function leafOf(schema: unknown): Record<string, unknown> | undefined {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
  if (!def) return undefined;
  if (['optional', 'nullable', 'default', 'prefault', 'readonly'].includes(String(def.type))) return leafOf(def.innerType);
  return def;
}

describe('the list of one-time link members (M3-12)', () => {
  it('lists every link member of the answer of every idempotent route', () => {
    // The walk finds the links the operator commands answer with (and no boolean such as clientSecretSet).
    expect(linkMembers(CREATE.response)).toEqual(['data.invitationUrl']);
    expect(linkMembers(route('ops.operators.add').response)).toEqual(['data.link']);
    expect(linkMembers(route('admin.idp.create').response)).toEqual([]);
    const missing: string[] = [];
    for (const def of API_ROUTES.filter((r) => r.idempotent)) {
      const listed = new Set((ONE_TIME_SECRET_MEMBERS[def.id]?.members ?? []).map((p) => p.join('.')));
      for (const member of new Set(linkMembers(def.response))) if (!listed.has(member)) missing.push(`${def.id}: ${member}`);
    }
    expect(missing).toEqual([]);
    // Every entry names an idempotent route.
    const idempotent = new Set(API_ROUTES.filter((r) => r.idempotent).map((r) => r.id));
    expect(Object.keys(ONE_TIME_SECRET_MEMBERS).filter((id) => !idempotent.has(id))).toEqual([]);
  });

  it('replaces the token of a link the list does not name, says where, and never changes the answer sent', () => {
    const answer = {
      ok: true,
      changed: [],
      downloadUrl: 'https://mscd.example.id/api/v1/ms/isms/calendar.ics?token=abcdefghijklmnopqrstuvwxyz012345',
      message: ['Give https://mscd.example.id/guest#k3y-of-the-guest to the auditor', 'Berikan tautannya'],
      data: { id: 'x', note: 'plain text' },
    };
    const before = JSON.stringify(answer);
    const result = idempotentBodyToStore('calendar-feed.create', answer);
    expect(JSON.stringify(answer)).toBe(before);
    expect(result.removed).toEqual([]);
    expect(result.unlisted).toEqual(['downloadUrl', 'message[0]']);
    expect(result.body).toEqual({
      ...answer,
      downloadUrl: 'https://mscd.example.id/api/v1/ms/isms/calendar.ics?token=removed',
      message: ['Give https://mscd.example.id/guest#removed to the auditor', 'Berikan tautannya'],
    });
    // A listed member goes, with the replay message; an answer without it keeps its own message.
    const listed = idempotentBodyToStore('ops.accounts.password-reset', {
      ok: true, changed: [], message: ['Give the link yourself', 'Berikan sendiri'],
      data: { id: 'x', sessionsRevoked: 0, emailed: false, status: 'active', link: 'https://mscd.example.id/reset-password#token=abc', expiresAt: '2026-11-01T00:30:00Z' },
    });
    expect(listed.removed).toEqual(['data.link', 'data.expiresAt']);
    expect(listed.unlisted).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain('reset-password');
    const emailed = idempotentBodyToStore('ops.accounts.password-reset', { ok: true, changed: [], message: ['Emailed', 'Dikirim'], data: { id: 'x', emailed: true } });
    expect(emailed).toEqual({ body: { ok: true, changed: [], message: ['Emailed', 'Dikirim'], data: { id: 'x', emailed: true } }, removed: [], unlisted: [] });
  });
});
