// Pending approvals (MILESTONE-2 M2-10): routes against the shared table, the pending grants with their requester and
// approvers, who may decide (F.6: never the requester or the grantee, only a Tenant Admin; A-50 for routing changes),
// the sidebar badge (one onboarding request and the routing rules in API builds, the sample's session state otherwise),
// the loader over a fake fetch, and the views in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/approvals/index';
import { layerItems } from '../../src/screens/approvals/actions';
import { ROUTES, ROUTE_IDS } from '../../src/screens/approvals/routes';
import { APPROVAL_PERMS, apiPendingCount, badgeCount, loadPendingCount, onBadgeCount, setBadgeCount } from '../../src/screens/approvals/badge';
import { approverNames, grantDecisionBlock, isTenantAdmin, pendingGrants } from '../../src/screens/approvals/model';
import type { PendingGrant } from '../../src/screens/approvals/model';
import { GrantsTable, RulesTable, loadApprovals, waitingCount } from '../../src/screens/approvals/Screen';
import { TEXT } from '../../src/screens/approvals/text';
import { createApiAdapter as usersApi } from '../../src/screens/users/api';
import { createSampleAdapter as usersSample, resetSampleUsers, sampleMembers, sampleSystems } from '../../src/screens/users/sample';
import { createApiAdapter as routingApi } from '../../src/screens/routing/api';
import { createSampleAdapter as routingSample, resetSampleRouting } from '../../src/screens/routing/sample';
import type { Member } from '../../src/screens/users/model';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'approvals', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ISMS_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const GRANT_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const user = (handle: string, adminRoles: string[], roles: unknown[] = []) => ({
  id: `u-${handle}`, handle, email: `${handle}@mscd.test`, displayName: handle.toUpperCase(), jobTitle: null, kind: 'person', accountStatus: 'active', membershipStatus: 'active',
  adminRoles, roles, mfaEnrolled: true, otherMemberships: false, lastLoginAt: null,
});

afterEach(() => {
  resetSampleUsers();
  resetSampleRouting();
  setBadgeCount(0);
});

describe('approvals routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.rolesApprove).permission).toBe('user.manage');
    expect(routeById(ROUTE_IDS.rulesApprove).permission).toBe('storage.routing.manage');
    expect(routeById(ROUTE_IDS.onboarding).permission).toBe('ms.admin');
  });
});

describe('pending grants and who decides', () => {
  const { members, history } = sampleMembers(D);
  const grants = pendingGrants(members, sampleSystems(D), history);

  it('lists the waiting grants, oldest request first, with the requester and the approvers', () => {
    expect(grants.map((g) => [g.member.handle, g.role, g.system.code, g.requestedBy?.handle])).toEqual([['yusuf', 'risk_owner', 'ISMS', 'tono'], ['rina', 'programme_owner', 'QMS', 'rina']]);
    expect(approverNames(members, grants[0])).toEqual(['Rina Kusuma']);
    expect(approverNames(members, grants[1])).toEqual(['Tono Hartono']);
  });

  it('never the grantee, never the requester, only a Tenant Admin', () => {
    const rina = ctxOf('en');
    expect(grantDecisionBlock(rina, grants[0])).toBeNull();
    expect(grantDecisionBlock(rina, grants[1])).toEqual(TEXT.forYou);
    const tono = ctxOf('en', { person: { handle: 'tono', name: 'Tono', jobTitle: '-' } });
    expect(grantDecisionBlock(tono, grants[0])).toEqual(TEXT.ownGrant);
    const storageAdmin = ctxOf('en', { mode: 'api', me: { user: { id: 'u-bagus', handle: 'bagus' }, adminRoles: ['storage_admin'] } as never });
    expect(grantDecisionBlock(storageAdmin, grants[0])).toEqual(TEXT.onlyTenantAdmin);
    expect([isTenantAdmin(rina), isTenantAdmin(storageAdmin), isTenantAdmin(ctxOf('en', { orgCan: () => false }))]).toEqual([true, false, false]);
  });
});

describe('the sidebar badge', () => {
  it('keeps the number and tells its listeners when it changes', () => {
    const heard: number[] = [];
    const stop = onBadgeCount((n) => heard.push(n));
    expect(setBadgeCount(3)).toBe(true);
    expect(setBadgeCount(3)).toBe(false);
    expect(setBadgeCount(-1)).toBe(true);
    stop();
    setBadgeCount(5);
    expect([badgeCount(), heard]).toEqual([5, [3, 0]]);
    expect(screen.count!(ctxOf('en'))).toBe(5);
  });

  it('API builds: the pending_grants step of the onboarding checklist and the pending routing changes', async () => {
    const f = fakeFetch({
      'GET /api/v1/admin/onboarding': json([{ key: 'licence', state: 'done', screen: 'license' }, { key: 'pending_grants', state: 'pending', screen: 'approvals', count: 2 }]),
      'GET /api/v1/admin/storage/routing-rules': json([{ approvalStatus: 'pending_approval' }, { approvalStatus: 'active' }]),
    });
    const client = new ApiClient({ fetch: f.fetch });
    expect(await apiPendingCount(ctxOf('en', { mode: 'api', client }))).toBe(3);
    expect(await apiPendingCount(ctxOf('en', { mode: 'api', client, orgCan: (p) => p === 'storage.repository.read' }))).toBe(1);
    expect(f.calls.map((c) => c.path)).toEqual(['/api/v1/admin/onboarding', '/api/v1/admin/storage/routing-rules', '/api/v1/admin/storage/routing-rules']);
    const failing = fakeFetch({});
    expect(await apiPendingCount(ctxOf('en', { mode: 'api', client: new ApiClient({ fetch: failing.fetch }) }))).toBeNull();
  });

  it('sample builds: the sample grants and routing changes of this session', async () => {
    expect(await loadPendingCount(ctxOf('en'))).toBe(4);
    await routingSample(() => D, () => 'rina').reject('sample-rule-pending-bcms').catch(() => undefined);
    await routingSample(() => D, () => 'rina').approve('sample-rule-pending-bcms');
    expect(await loadPendingCount(ctxOf('en'))).toBe(3);
  });

  it('a layer item loads the badge for sessions that open the screen', () => {
    expect(layerItems.map((i) => i.id)).toEqual(['approvals-badge']);
    expect(layerItems[0].visible!(ctxOf('en'))).toBe(true);
    expect(layerItems[0].visible!(ctxOf('en', { orgCan: () => false }))).toBe(false);
    expect(layerItems[0].visible!(ctxOf('en', { org: null }))).toBe(false);
    expect(render(<>{(() => { const C = layerItems[0].Component; return <C ctx={ctxOf('en')} />; })()}</>, ctxOf('en'))).toBe('<div class="mscd" data-theme="light"></div>');
  });
});

describe('loading the approvals', () => {
  it('reads the members, systems, the requesters of the waiting grants and the routing rules; one failing part leaves the other', async () => {
    const waiting = user('bagus', ['storage_admin'], [{ grantId: GRANT_ID, ms: 'isms', role: 'risk_owner', isPrimary: false, approvalStatus: 'pending_approval', validUntil: null }]);
    const f = fakeFetch({
      'GET /api/v1/admin/users': json({ items: [user('tenant.admin', ['tenant_admin']), user('rina', ['tenant_admin', 'storage_admin']), waiting], page: 1, pageSize: 200, total: 3 }),
      'GET /api/v1/admin/management-systems': json([{ id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'Information security', status: 'implementing' }]),
      'GET /api/v1/admin/audit-trail': json({ items: [{ seq: 1, occurredAt: '2026-10-28T01:00:00Z', actor: { handle: 'tenant.admin', displayName: 'Tenant Admin', kind: 'user' }, action: 'role.grant_requested', entityType: 'user_ms_role', entityId: GRANT_ID }], page: 1, pageSize: 50, total: 1 }),
      'GET /api/v1/admin/storage/routing-rules': { status: 500, body: { title: 'x' }, headers: { 'content-type': 'application/problem+json' } },
    });
    const client = new ApiClient({ fetch: f.fetch });
    const ctx = ctxOf('en', { mode: 'api', client, me: { user: { id: 'u-tenant.admin', handle: 'tenant.admin' }, adminRoles: ['tenant_admin'] } as never });
    const data = await loadApprovals(ctx, usersApi(client), routingApi(client, { systems: false, fallbackSystems: [] }));
    expect(data.grants!.map((g) => [g.member.handle, g.system.id, g.requestedBy?.handle])).toEqual([['bagus', ISMS_ID, 'tenant.admin']]);
    expect(approverNames(data.members!, data.grants![0])).toEqual(['RINA']);
    expect(grantDecisionBlock(ctx, data.grants![0])).toEqual(TEXT.ownGrant);
    expect(data.routing).toBeNull();
    expect(data.errors).toHaveLength(1);
    expect(waitingCount(data)).toBe(1);
    expect(f.calls.find((c) => c.path === '/api/v1/admin/audit-trail')!.url).toContain(`entityId=${GRANT_ID}`);
  });

  it('reads only what the session may read', async () => {
    const f = fakeFetch({});
    const client = new ApiClient({ fetch: f.fetch });
    const data = await loadApprovals(ctxOf('en', { mode: 'api', client, orgCan: () => false }), usersApi(client), routingApi(client, { systems: false, fallbackSystems: [] }));
    expect([data.grants, data.routing, f.calls.length]).toEqual([null, null, 0]);
  });
});

describe('approvals views', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the waiting grants and routing changes in ${lang}, ${theme} theme`, async () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const data = await loadApprovals(ctx, usersSample(() => D, () => 'rina'), routingSample(() => D, () => 'rina'));
        const grants = render(<GrantsTable ctx={ctx} grants={data.grants!} members={data.members!} busy={null} onApprove={() => undefined} onReject={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colPerson, TEXT.colRole, TEXT.colRequested, TEXT.colApprovers, TEXT.colActions, TEXT.approve, TEXT.reject, TEXT.forYou, TEXT.admin]) expect(grants, p[0]).toContain(t(p));
        expect(grants).toContain('Tono Hartono');
        expect(grants.split(t(TEXT.forYou)).length).toBe(2);
        const rules = render(<RulesTable ctx={ctx} data={data.routing!} rules={data.routing!.rules.filter((r) => r.approvalStatus === 'pending_approval')} busy={null} onApprove={() => undefined} onReject={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colSystem, TEXT.colAppliesTo, TEXT.colTarget, TEXT.colRequested]) expect(rules, p[0]).toContain(t(p));
        expect(rules).toContain('BCMS');
        expect(waitingCount(data)).toBe(4);
        expect(grants + rules).not.toMatch(/[—·]/);
      });
    }
  }

  it('a reader without storage.routing.manage sees the routing changes without the decision', async () => {
    const ctx = ctxOf('en', { orgCan: (p) => p !== 'storage.routing.manage' });
    const data = await loadApprovals(ctx, usersSample(() => D, () => 'rina'), routingSample(() => D, () => 'rina'));
    const rules = render(<RulesTable ctx={ctx} data={data.routing!} rules={data.routing!.rules} busy={null} onApprove={() => undefined} onReject={() => undefined} />, ctx);
    expect(rules).not.toContain('Approve');
    const grant = data.grants![0] as PendingGrant;
    const members: Member[] = data.members!;
    expect(render(<GrantsTable ctx={ctx} grants={[{ ...grant, requestedBy: null }]} members={members} busy={grant.grantId} onApprove={() => undefined} onReject={() => undefined} />, ctx)).toContain(TEXT.unknown[0]);
    // The person who asked is named from the members list when the snapshot does not know them.
    const rule = { ...data.routing!.rules[0], requestedBy: 'tenant.admin' };
    const named = render(<RulesTable ctx={ctx} data={data.routing!} rules={[rule]} members={[{ ...members[0], handle: 'tenant.admin', displayName: 'Tenant Admin' }]} busy={null} onApprove={() => undefined} onReject={() => undefined} />, ctx);
    expect(named).toContain('Tenant Admin, ');
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    // "Administrator" is the Indonesian term too, as on People and roles.
    const same = new Set(['admin']);
    for (const [key, pair] of Object.entries(TEXT)) {
      if (!same.has(key)) expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the Administration group for Tenant Admins and Storage Admins, with a badge', () => {
    expect(screen).toMatchObject({ id: 'approvals', path: '/admin/users/approvals', group: 'admin', scope: 'org', perm: APPROVAL_PERMS });
    expect(typeof screen.count).toBe('function');
    expect(screen.pageActions).toBeUndefined();
  });
});
