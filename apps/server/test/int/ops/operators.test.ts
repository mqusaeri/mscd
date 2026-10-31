// The platform operators of the service (Milestone 2 section L, M2-19): the list with `self`; adding an operator as
// `admin create-operator` does, with the operator as actor and `granted_by` (a new account gets the set-password link
// by email and uses it; an account with a password gets the notice; the refusals); removing an operator (the role and
// every session end; never the own account, never the last active operator); and the mail rule.
import { type OpsOperatorAddResult, type OpsOperatorItem, type OpsOperatorRemoveResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID, type Principal } from '../../../src/common/tokens';
import { OperatorsService } from '../../../src/modules/ops/operators.service';
import { useTestDatabase } from '../../setup/test-db';
import { anonymous, type FullApp } from '../contract/harness';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, createOnboardingApp, inPlatform, resetRateLimits, sessionIn, type Client, type Person } from '../onboarding/helpers';
import { ADD_OPERATOR, OPERATORS, REMOVE_OPERATOR, auditAbout, call, sessionsOf } from './accounts-helpers';

const REASON = 'Second operator for the on-call rota';

async function roleOf(db: ReturnType<typeof useTestDatabase>, userId: string) {
  return inPlatform(db, (trx) =>
    trx.selectFrom('platform.platform_role').select(['revoked_at', 'granted_by']).where('user_id', '=', userId).where('role', '=', 'platform_operator').executeTakeFirst(),
  );
}

describe('platform operators of the service (Milestone 2 M2-19)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let full: FullApp;
  let operator: Person;
  let op: Client;

  beforeAll(async () => {
    mail = await startMailpit();
    operator = await addPerson(db, 'ops.owner', [], { platformOperator: true, password: true });
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

  it('adds a new operator, who sets the password with the emailed link', async () => {
    const reply = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, { body: { email: 'Nadia.Operator@Platform.test', name: 'Nadia Putri', reason: REASON } });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.body.data).toMatchObject({ email: 'Nadia.Operator@Platform.test', handle: 'nadia.operator', newAccount: true, emailed: true });
    expect(reply.body.data.link).toBeUndefined();
    const id = reply.body.data.id;
    expect(await roleOf(db, id)).toEqual({ revoked_at: null, granted_by: operator.id });
    const message = await mail.waitFor('nadia.operator@platform.test', (m) => m.mailKind.endsWith(':operator_invitation'));
    const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    expect(token).toBeTruthy();
    const list = await call<OpsOperatorItem[]>(op, OPERATORS);
    expect(list.body.find((o) => o.id === id)).toMatchObject({ displayName: 'Nadia Putri', passwordSet: false, mfaEnrolled: false, self: false, grantedBy: { handle: 'ops.owner' } });
    expect(list.body.find((o) => o.id === operator.id)?.self).toBe(true);
    const used = await anonymous(full).post('/api/v1/auth/password/reset', { token, password: 'Operator-password-of-test-77' });
    expect(used.status, used.text).toBe(204);
    const after = await call<OpsOperatorItem[]>(op, OPERATORS);
    expect(after.body.find((o) => o.id === id)?.passwordSet).toBe(true);
    const [entry] = await auditAbout(db, id, 'ops.operator_created');
    expect(entry).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id, organization_id: null, entity_code: 'nadia.operator' });
    expect(entry!.after_data).toMatchObject({ newAccount: true, roleGranted: true, setPasswordLink: true, mfaRequired: true, reason: REASON });
    // A second request for an operator that set its password is refused.
    const again = await call(op, ADD_OPERATOR, { body: { email: 'nadia.operator@platform.test', name: 'Nadia Putri', reason: REASON } });
    expect([again.status, again.body.messageKey]).toEqual([409, 'already_operator']);
  });

  it('grants the role to an existing account with a password, which is told by email', async () => {
    const person = await addPerson(db, 'existing.op', [], { password: true, domain: 'platform.test' });
    const reply = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, { body: { email: person.email, name: 'Ignored for an existing account', reason: REASON } });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.body.data).toMatchObject({ id: person.id, newAccount: false, emailed: true });
    await mail.waitFor(person.email, (m) => m.mailKind.endsWith(':operator_granted'));
    const names = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('display_name').where('id', '=', person.id).executeTakeFirstOrThrow());
    expect(names.display_name).toBe(person.displayName);
  });

  it('refuses the system account and a disabled account', async () => {
    const system = await call(op, ADD_OPERATOR, { body: { email: 'system@mscd.invalid', name: 'System', reason: REASON } });
    expect([system.status, system.body.messageKey]).toEqual([409, 'system_account']);
    const disabled = await addPerson(db, 'disabled.op', [], { password: true, status: 'disabled' });
    const refused = await call(op, ADD_OPERATOR, { body: { email: disabled.email, name: 'Disabled', reason: REASON } });
    expect([refused.status, refused.body.messageKey]).toEqual([409, 'account_disabled']);
    expect(await roleOf(db, disabled.id)).toBeUndefined();
  });

  it('removes an operator: the role and every session end, the memberships stay', async () => {
    const other = await addPerson(db, 'remove.me', [], { platformOperator: true, password: true });
    const client = await sessionIn(full, other.id, null);
    expect((await client.get('/api/v1/ops/health')).status).toBe(200);
    const reply = await call<OpsOperatorRemoveResult>(op, REMOVE_OPERATOR, { params: { id: other.id }, body: { reason: 'Left the operations team' } });
    expect(reply.status, reply.text).toBe(200);
    expect(reply.body.data).toMatchObject({ id: other.id, sessionsRevoked: 1 });
    expect((await roleOf(db, other.id))?.revoked_at).not.toBeNull();
    expect((await client.get('/api/v1/me')).status).toBe(401);
    expect(await sessionsOf(db, other.id)).toEqual({ open: 0, reasons: ['roles_changed'] });
    const [entry] = await auditAbout(db, other.id, 'ops.operator_revoked');
    expect(entry).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id });
    expect(entry!.after_data).toMatchObject({ reason: 'Left the operations team', sessionsRevoked: 1 });
    const list = await call<OpsOperatorItem[]>(op, OPERATORS);
    expect(list.body.map((o) => o.id)).not.toContain(other.id);
    const again = await call(op, REMOVE_OPERATOR, { params: { id: other.id }, body: { reason: REASON } });
    expect([again.status, again.body.messageKey]).toEqual([404, 'not_operator']);
    expect(again.body.messages?.id).toBeTruthy();
  });

  it('never removes the own account or the last active operator, and refuses the system account', async () => {
    const own = await call(op, REMOVE_OPERATOR, { params: { id: operator.id }, body: { reason: REASON } });
    expect([own.status, own.body.messageKey]).toEqual([403, 'own_account']);
    const system = await call(op, REMOVE_OPERATOR, { params: { id: SYSTEM_USER_ID }, body: { reason: REASON } });
    expect([system.status, system.body.messageKey]).toEqual([409, 'system_account']);
    // Every other operator of this database leaves first; then the acting operator's own role ends, so the one left
    // is the last active operator. The guard admits only active operators, so this is checked on the service.
    const last = await addPerson(db, 'last.op', [], { platformOperator: true, password: true });
    await inPlatform(db, (trx) => sql`update platform.platform_role set revoked_at = now() where user_id <> ${last.id} and revoked_at is null`.execute(trx));
    try {
      const service = full.get<OperatorsService>(OperatorsService);
      const principal = { user: { id: operator.id, handle: operator.handle, displayName: operator.displayName } } as unknown as Principal;
      await expect(service.remove(principal, last.id, REASON)).rejects.toMatchObject({ extras: { messageKey: 'last_operator' } });
      expect((await roleOf(db, last.id))?.revoked_at).toBeNull();
    } finally {
      await inPlatform(db, (trx) => sql`update platform.platform_role set revoked_at = null where user_id = ${operator.id}`.execute(trx));
    }
  });

  it('is refused to a person without the operator role', async () => {
    const person = await addPerson(db, 'not.operator', [], { password: true });
    const client = await sessionIn(full, person.id, null);
    expect((await call(client, OPERATORS)).status).toBe(403);
  });
});

describe('the mail rule of adding an operator (Milestone 2 M2-19)', () => {
  const db = useTestDatabase('empty');

  it('with mail.required and mail not working, creates nothing (409 mail_required); without it, answers the link once', async () => {
    const operator = await addPerson(db, 'ops.mail', [], { platformOperator: true, password: true });
    const required = await createOnboardingApp(db, { mail: null, env: { MSCD__MAIL__REQUIRED: 'true' } });
    try {
      const op = await sessionIn(required, operator.id, null);
      const reply = await call(op, ADD_OPERATOR, { body: { email: 'new.op@platform.test', name: 'New Operator', reason: REASON } });
      expect([reply.status, reply.body.messageKey]).toEqual([409, 'mail_required']);
      const found = await inPlatform(db, (trx) => trx.selectFrom('platform.app_user').select('id').where('email', '=', 'new.op@platform.test').execute());
      expect(found).toEqual([]);
    } finally {
      await required.close();
    }
    const off = await createOnboardingApp(db, { mail: null });
    try {
      const op = await sessionIn(off, operator.id, null);
      const reply = await call<OpsOperatorAddResult>(op, ADD_OPERATOR, { body: { email: 'new.op@platform.test', name: 'New Operator', reason: REASON } });
      expect(reply.status, reply.text).toBe(201);
      expect(reply.body.data.emailed).toBe(false);
      expect(reply.body.data.link).toMatch(/\/reset-password#token=/);
    } finally {
      await off.close();
    }
  });
});
