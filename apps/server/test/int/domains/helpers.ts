// Helpers of the email domain tests (Milestone 2 K.6, M2-S11): the multi-tenancy api application whose DNS lookups go
// to the mock DNS responder of tools/mock-providers, the operator routes of `ops.domains.*`, the stored rows and their
// audit entries, sign-in discovery from outside, and identity providers written directly.
import { createHash } from 'node:crypto';
import { startMockProviders, mockState, type DnsZone, type RunningMockProviders } from '@mscd/mock-providers';
import { API_ROUTES } from '@mscd/shared';
import { sql } from 'kysely';
import type { TestDatabase } from '../../setup/test-db';
import { Client, callRoute, type FullApp, type RouteCall } from '../contract/harness';
import { inPlatform } from '../onboarding/helpers';

export { MULTI } from '../entitlements/helpers';

export const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
export const LIST = route('ops.domains.list');
export const ADD = route('ops.domains.add');
export const VERIFY = route('ops.domains.verify');
export const REMOVE = route('ops.domains.remove');
export const PROVIDERS = route('auth.providers');

/** The problem type URL of a slug, as the problem filter writes it. */
export const problemType = (slug: string) => `https://mscd.cyberlentera.com/problems/${slug}`;

/** The mock DNS responder and its zone; `resolvers` is the value of `network.dns_resolvers`. */
export interface MockDns {
  running: RunningMockProviders;
  zone: DnsZone;
  resolvers: string;
  close(): Promise<void>;
}

export async function startMockDns(): Promise<MockDns> {
  const running = await startMockProviders({ dnsPort: 0 });
  return { running, zone: mockState(running.app).dns, resolvers: `["${running.dns!.address}"]`, close: () => running.close() };
}

/** Anything the route answers: the success body or a problem. */
export type Answer = Record<string, unknown> & { messageKey?: string; type?: string; messages?: { en: string; id: string } };

export function list(op: Client, org: string): Promise<RouteCall<Answer[] & Answer>> {
  return callRoute(op, LIST, { params: { org } });
}

export function add(op: Client, org: string, domain: string): Promise<RouteCall<Answer>> {
  return callRoute(op, ADD, { params: { org }, body: { domain } });
}

export function verify(op: Client, org: string, domain: string): Promise<RouteCall<Answer>> {
  return callRoute(op, VERIFY, { params: { org, domain } });
}

export function remove(op: Client, org: string, domain: string): Promise<RouteCall<Answer>> {
  return callRoute(op, REMOVE, { params: { org, domain } });
}

/** The stored row of a domain of an organisation (undefined when there is none). */
export async function domainRow(db: TestDatabase, orgId: string, domain: string) {
  return inPlatform(db, (trx) => trx.selectFrom('platform.verified_domain').selectAll().where('organization_id', '=', orgId).where('domain', '=', domain).executeTakeFirst());
}

/** The SHA-256 of a token, as the server stores it. */
export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The platform audit entries of the domain actions for one domain, oldest first. */
export async function domainAudit(db: TestDatabase, domain: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['action', 'organization_id', 'actor_kind', 'actor_user_id', 'entity_type', 'entity_code', 'before_data', 'after_data'])
      .where('entity_code', '=', domain)
      .where('action', 'in', ['ops.domain_added', 'ops.domain_verified', 'ops.domain_verification_failed', 'ops.domain_removed', 'tenant.domain_verified'])
      .orderBy('seq')
      .execute(),
  );
}

/** Moves the times of a domain back (days before now), as if it had been added or checked that long ago. */
export async function ageDomain(db: TestDatabase, orgId: string, domain: string, days: { requested?: number; verified?: number; checked?: number | null }): Promise<void> {
  const back = (n: number) => sql<Date>`now() - make_interval(days => ${n})`;
  await inPlatform(db, (trx) =>
    trx
      .updateTable('platform.verified_domain')
      .set({
        ...(days.requested !== undefined ? { requested_at: back(days.requested) } : {}),
        ...(days.verified !== undefined ? { verified_at: back(days.verified) } : {}),
        ...(days.checked !== undefined ? { last_checked_at: days.checked === null ? null : back(days.checked) } : {}),
      })
      .where('organization_id', '=', orgId)
      .where('domain', '=', domain)
      .execute(),
  );
}

/** An enabled OpenID Connect provider of an organisation (the login page lists it). */
export async function addProvider(db: TestDatabase, orgId: string, slug: string, label: string): Promise<void> {
  await inPlatform(db, (trx) =>
    trx
      .insertInto('platform.identity_provider')
      .values({ organization_id: orgId, slug, kind: 'oidc', display_name: label, icon: 'microsoft', oidc_issuer: 'https://login.example.test/v2.0', oidc_client_id: 'mscd' })
      .execute(),
  );
}

/** `GET /auth/providers` from outside, without a session, from one address. */
export async function discover(full: FullApp, query: Record<string, string>, remoteAddress = '127.0.0.1') {
  const search = new URLSearchParams(query).toString();
  const reply = await full.app.inject({ method: 'GET', url: `/api/v1/auth/providers${search ? `?${search}` : ''}`, remoteAddress });
  return { status: reply.statusCode, body: reply.json() as Answer, headers: reply.headers };
}
