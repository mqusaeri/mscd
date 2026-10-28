// API adapter of the People and roles screen (MILESTONE-2 M2-10): the member, role grant, holdings and identity routes
// of D.2 and D.1 through the host's client (R-17). The systems come from `admin.ms.list` (their uuids name the grant
// routes), the providers from `admin.idp.list`, the tenancy mode from `admin.organization.get`, and who asked for and
// who decided on a grant from the audit trail metadata a Tenant Admin may read (`audit_trail.metadata.read`). After a
// change of the session user's own roles, `GET /me` gives the client the CSRF token of the renewed session (F.1).
import type {
  AuditEntryMeta, CommandResult, IdentityProviderView, ManagementSystemView, Me, OrganizationSettings, Page, RoleGrantResult, UserHoldings, UserView,
} from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { call } from '../api';
import type { TextPair } from '../types';
import type { GrantHistory, HoldingsSystem, Member, Result, SessionRoles, SystemRef, UsersAdapter } from './model';
import { ROUTES } from './routes';

/** Pages of 200 members, at most 25 of them (5,000 members). */
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export function fromUserView(view: UserView): Member {
  return {
    id: view.id,
    handle: view.handle,
    email: view.email,
    displayName: view.displayName,
    jobTitle: view.jobTitle,
    kind: view.kind,
    accountStatus: view.accountStatus,
    membershipStatus: view.membershipStatus,
    adminRoles: [...view.adminRoles],
    roles: view.roles.map((g) => ({ grantId: g.grantId, ms: g.ms, role: g.role, isPrimary: g.isPrimary, approvalStatus: g.approvalStatus, validUntil: g.validUntil })),
    mfaEnrolled: view.mfaEnrolled,
    otherMemberships: view.otherMemberships,
    lastLoginAt: view.lastLoginAt,
  };
}

export function fromSystemView(view: ManagementSystemView): SystemRef {
  return { id: view.id, slug: view.slug, code: view.code, name: view.name, archived: view.status === 'archived' };
}

/** The roles of `GET /me` that decide what follows a change of the session user's own roles. */
export function sessionRolesOf(me: Pick<Me, 'adminRoles' | 'rolesByMs' | 'uiRoleByMs'>): SessionRoles {
  return {
    adminRoles: [...me.adminRoles],
    rolesByMs: Object.fromEntries(Object.entries(me.rolesByMs).map(([ms, roles]) => [ms, [...roles]])),
    uiRoleByMs: { ...me.uiRoleByMs },
  };
}

export function fromHoldings(view: UserHoldings): HoldingsSystem[] {
  return view.systems.map((s) => ({ ms: s.ms, name: s.name, primaryManager: s.primaryManager ? { ...s.primaryManager } : null, counts: { ...s.counts }, total: s.total }));
}

const messageOf = (result: { message?: unknown } | null | undefined): TextPair | null =>
  (Array.isArray(result?.message) ? [String(result!.message[0]), String(result!.message[1])] : null);

function done<T>(res: ApiResult<unknown>, data: T, message: TextPair | null = null): Result<T> {
  return res.ok ? { ok: true, data, message } : { ok: false, error: res.error };
}

/**
 * Who asked for and who decided on each grant, from audit entries of entity type `user_ms_role`, newest first:
 * `role.grant_requested` names the requester, `role.granted`, `role.grant_approved` and `role.grant_rejected` the
 * person who decided. A grant asked for again after a rejection keeps its newest request.
 */
export function historyOf(entries: readonly AuditEntryMeta[]): Record<string, GrantHistory> {
  const out: Record<string, GrantHistory> = {};
  for (const e of entries) {
    if (!e.entityId) continue;
    const h = (out[e.entityId] ??= { requestedBy: null, requestedAt: null, decidedBy: null, decidedAt: null });
    const who = { handle: e.actor.handle, name: e.actor.displayName ?? e.actor.handle ?? '-' };
    if (e.action === 'role.grant_requested' && !h.requestedAt) {
      h.requestedBy = who;
      h.requestedAt = e.occurredAt;
    }
    if ((e.action === 'role.granted' || e.action === 'role.grant_approved' || e.action === 'role.grant_rejected') && !h.decidedAt) {
      h.decidedBy = who;
      h.decidedAt = e.occurredAt;
    }
  }
  return out;
}

export function createApiAdapter(client: ApiClient | null): UsersAdapter {
  /** Every page of a paged list route. */
  async function allPages<T>(route: readonly [string, string], query: Record<string, string | number> = {}): Promise<ApiResult<T[]>> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await call<Page<T>>(client, route as typeof ROUTES.usersList, { query: { ...query, page, pageSize: PAGE_SIZE } });
      if (!res.ok) return res;
      items.push(...res.data.items);
      if (items.length >= res.data.total || res.data.items.length === 0) break;
    }
    return { ok: true, status: 200, data: items };
  }

  const command = (res: ApiResult<CommandResult | null>) => done(res, null, res.ok ? messageOf(res.data) : null);

  return {
    async members() {
      const res = await allPages<UserView>(ROUTES.usersList);
      return res.ok ? { ok: true, data: res.data.map(fromUserView) } : { ok: false, error: res.error };
    },
    async systems() {
      const res = await call<ManagementSystemView[]>(client, ROUTES.msList);
      return res.ok ? { ok: true, data: res.data.map(fromSystemView) } : { ok: false, error: res.error };
    },
    async providers() {
      const res = await call<IdentityProviderView[]>(client, ROUTES.idpList);
      return res.ok ? { ok: true, data: res.data.map((p) => ({ slug: p.slug, name: p.displayName, kind: p.kind, enabled: p.enabled })) } : { ok: false, error: res.error };
    },
    async org() {
      const res = await call<OrganizationSettings>(client, ROUTES.orgGet);
      return res.ok ? { ok: true, data: { tenancyMode: res.data.tenancyMode } } : { ok: false, error: res.error };
    },
    async invite(body, idempotencyKey) {
      const res = await call(client, ROUTES.usersCreate, { body, idempotencyKey });
      return done(res, null);
    },
    async update(id, patch) {
      const res = await call<UserView>(client, ROUTES.usersUpdate, { params: { id }, body: patch });
      return res.ok ? { ok: true, data: fromUserView(res.data) } : { ok: false, error: res.error };
    },
    async grant(system, body, idempotencyKey) {
      const res = await call<RoleGrantResult>(client, ROUTES.rolesGrant, { params: { id: system.id }, body, idempotencyKey });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { approvalStatus: res.data.data.approvalStatus, grantId: res.data.data.grantId }, message: messageOf(res.data) };
    },
    approve: async (system, grantId) => command(await call<CommandResult>(client, ROUTES.rolesApprove, { params: { id: system.id, roleId: grantId } })),
    reject: async (system, grantId) => command(await call<CommandResult>(client, ROUTES.rolesReject, { params: { id: system.id, roleId: grantId } })),
    revoke: async (system, grantId) => command(await call<null>(client, ROUTES.rolesRevoke, { params: { id: system.id, roleId: grantId } })),
    async holdings(userId) {
      const res = await call<UserHoldings>(client, ROUTES.usersHoldings, { params: { id: userId } });
      return res.ok ? { ok: true, data: fromHoldings(res.data) } : { ok: false, error: res.error };
    },
    registerIdentity: async (userId, body, idempotencyKey) => command(await call<CommandResult>(client, ROUTES.usersIdentity, { params: { id: userId }, body, idempotencyKey })),
    resetMfa: async (userId) => command(await call<null>(client, ROUTES.usersResetMfa, { params: { id: userId } })),
    async history(ids) {
      if (ids === null) {
        const res = await allPages<AuditEntryMeta>(ROUTES.auditList, { entityType: 'user_ms_role' });
        return res.ok ? { ok: true, data: historyOf(res.data) } : { ok: false, error: res.error };
      }
      const pages = await Promise.all(ids.map((id) => call<Page<AuditEntryMeta>>(client, ROUTES.auditList, { query: { entityType: 'user_ms_role', entityId: id, pageSize: 50 } })));
      const failed = pages.find((p) => !p.ok);
      if (failed && !failed.ok) return { ok: false, error: failed.error };
      return { ok: true, data: historyOf(pages.flatMap((p) => (p.ok ? p.data.items : []))) };
    },
    async currentGrant(member, grantId) {
      // The member list narrowed by the email (`q` takes at most 100 characters), then the member by id.
      const q = member.email.slice(0, 100);
      const res = await allPages<UserView>(ROUTES.usersList, q ? { q } : {});
      if (!res.ok) return { ok: false, error: res.error };
      const view = res.data.find((v) => v.id === member.id);
      return { ok: true, data: (view ? fromUserView(view).roles.find((g) => g.grantId === grantId) : undefined) ?? null };
    },
    async renewSession() {
      // The client keeps the `csrfToken` of this answer for the next change (ApiClient reads it from any answer).
      const res = await call<Me>(client, ROUTES.me);
      return res.ok ? { ok: true, data: sessionRolesOf(res.data) } : { ok: false, error: res.error };
    },
  };
}
