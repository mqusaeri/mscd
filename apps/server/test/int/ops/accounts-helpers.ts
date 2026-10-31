// Helpers of the account and operator tests of the platform operator (Milestone 2 section L, M2-19): the routes by id,
// a call with the route contract checked, a confirmed second factor written as the migrator, sessions with a network
// address and a user agent, and the platform audit entries about an account.
import { API_ROUTES, type RouteDef } from '@mscd/shared';
import { sql } from 'kysely';
import type { TestDatabase } from '../../setup/test-db';
import { Client, callRoute, type RouteCall, type RouteInput } from '../contract/harness';
import { inPlatform } from '../onboarding/helpers';

export const route = (id: string): RouteDef => {
  const def = API_ROUTES.find((r) => r.id === id);
  if (!def) throw new Error(`no route ${id}`);
  return def;
};

export const ACCOUNTS = route('ops.accounts.list');
export const ACCOUNT = route('ops.accounts.get');
export const RESET_MFA = route('ops.accounts.reset-mfa');
export const PASSWORD_RESET = route('ops.accounts.password-reset');
export const RESEND = route('ops.accounts.invitation-resend');
export const REVOKE = route('ops.accounts.sessions-revoke');
export const STATUS = route('ops.accounts.status');
export const OPERATORS = route('ops.operators.list');
export const ADD_OPERATOR = route('ops.operators.add');
export const REMOVE_OPERATOR = route('ops.operators.remove');

/** A problem answer as the tests read it. */
export interface ProblemBody {
  type?: string;
  messageKey?: string;
  messages?: { en: string; id: string };
  detail?: string;
}

/** Calls a route and fails on any contract violation (J.3). */
export async function call<T = unknown>(client: Client, def: RouteDef, input: RouteInput = {}): Promise<RouteCall<T & ProblemBody>> {
  const reply = await callRoute<T & ProblemBody>(client, def, input);
  if (reply.violations.length > 0) throw new Error(`contract violations of ${def.id}: ${reply.violations.join('; ')}`);
  return reply;
}

/** A confirmed TOTP factor and two recovery codes of a user (the secret is never read by these routes). */
export async function addFactor(db: TestDatabase, userId: string): Promise<void> {
  await inPlatform(db, async (trx) => {
    await trx.insertInto('platform.mfa_factor').values({ user_id: userId, secret_sealed: 'sealed:test-secret-not-a-real-one', confirmed_at: new Date() }).execute();
    for (const n of [1, 2]) {
      await trx.insertInto('platform.mfa_recovery_code').values({ user_id: userId, code_hash: `recovery-${userId}-${n}` }).execute();
    }
  });
}

/** Writes the network address and the user agent of every open session of a user. */
export async function stampSessions(db: TestDatabase, userId: string, ip: string, userAgent: string): Promise<void> {
  await inPlatform(db, (trx) => sql`update platform.session set ip = ${ip}::inet, user_agent = ${userAgent} where user_id = ${userId} and revoked_at is null`.execute(trx));
}

/** Open sessions of a user and the revoke reasons of the ended ones. */
export async function sessionsOf(db: TestDatabase, userId: string): Promise<{ open: number; reasons: string[] }> {
  const rows = await inPlatform(db, (trx) => trx.selectFrom('platform.session').select(['revoked_at', 'revoke_reason']).where('user_id', '=', userId).execute());
  return { open: rows.filter((r) => r.revoked_at === null).length, reasons: rows.filter((r) => r.revoked_at !== null).map((r) => String(r.revoke_reason)) };
}

/** Platform audit entries about an account (entity the account), oldest first. */
export async function auditAbout(db: TestDatabase, userId: string, action?: string) {
  return inPlatform(db, (trx) => {
    let query = trx
      .selectFrom('platform.audit_log')
      .select(['action', 'actor_kind', 'actor_user_id', 'organization_id', 'entity_type', 'entity_code', 'before_data', 'after_data'])
      .where('entity_id', '=', userId)
      .orderBy('seq');
    if (action) query = query.where('action', '=', action);
    return query.execute();
  });
}
