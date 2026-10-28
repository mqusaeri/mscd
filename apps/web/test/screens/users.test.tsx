// People and roles (MILESTONE-2 M2-10): routes against the shared table, the model (who may do what under F.6 and
// D2-12, filters, form checks and the bodies of D.2, the roles and responsibilities CSV), the API adapter over a fake
// fetch (method, path, body, CSRF token, Idempotency-Key, refusals with their rule and field errors), the sample
// adapter with the four-eyes rule, and the views and dialogs in both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { UserView } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/users/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/users/routes';
import { createApiAdapter, fromUserView, historyOf, sessionRolesOf } from '../../src/screens/users/api';
import { createSampleAdapter, handleOfEmail, resetSampleUsers, sampleEmail, sampleMembers, sampleSystems, sampleUserHoldings } from '../../src/screens/users/sample';
import { adapterFor, deferredAdapter, settled, tenancyOf } from '../../src/screens/users/adapter';
import {
  EMPTY_FILTER, approversOf, csvCell, disableBlock, editPatch, endOfDay, errorText, filterMembers, grantBlock, grantBody, grantErrors, inviteBody,
  inviteErrors, isUserLimit, jobTitleBlock, needsApproval, refusalText, renewsOnEdit, renewsOnRevoke, revokesOwnRole, rolesCsv, sessionRestart, snapshotReload,
} from '../../src/screens/users/model';
import type { Member, UsersAdapter } from '../../src/screens/users/model';
import { Filters, MembersTable, PersonDrawer, grantText, loadUsers } from '../../src/screens/users/Screen';
import type { UsersData } from '../../src/screens/users/Screen';
import {
  ApprovalNote, DisableDialog, EditDialog, GrantDialog, InviteDialog, LimitAlert, PreRegisterDialog, ResetDialog, RevokeDialog, SystemHoldings,
  currentGrantOf, needsGrantRead, renewSession, revokeGrant, saveEdit,
} from '../../src/screens/users/dialogs';
import { TEXT } from '../../src/screens/users/text';
import { resetSampleHandover } from '../../src/screens/handover/sample';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: { id: 'ndt', name: 'Org', ms: [], deploy: 'onprem', sites: 1 }, me: null, person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: '-' },
    role: 'manager', mode: 'sample', client: null, ds: null, screen: 'users', params: {}, can: () => true, orgCan: () => true, platformCan: () => false,
    toast: vi.fn(), go: vi.fn(), track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ISMS_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const GRANT_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const USER: UserView = {
  id: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', handle: 'bagus', email: 'bagus.prasetyo@nusantaradigital.co.id', displayName: 'Bagus Prasetyo',
  jobTitle: 'IT Infrastructure Lead', kind: 'person', accountStatus: 'active', membershipStatus: 'active', adminRoles: [],
  roles: [{ grantId: GRANT_ID, ms: 'isms', role: 'domain_owner', isPrimary: false, approvalStatus: 'active', validUntil: null }],
  mfaEnrolled: true, otherMemberships: true, lastLoginAt: '2026-09-28T02:15:00Z',
};

const member = (over: Partial<Member> = {}): Member => ({ ...fromUserView(USER), ...over });
const admin = (id: string, handle: string, over: Partial<Member> = {}): Member => member({ id, handle, displayName: handle, adminRoles: ['tenant_admin'], roles: [], ...over });

afterEach(() => {
  resetSampleUsers();
  resetSampleHandover();
});

describe('users routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['usersList', 'usersCreate', 'usersUpdate', 'usersIdentity', 'usersHoldings', 'rolesGrant', 'rolesApprove', 'rolesReject', 'rolesRevoke'] as const) {
      expect(routeById(ROUTE_IDS[name]).permission, name).toBe('user.manage');
    }
    expect(routeById(ROUTE_IDS.idpList).permission).toBe('idp.manage');
    expect(routeById(ROUTE_IDS.orgGet).permission).toBe('org.settings.manage');
  });
});

describe('who may do what (F.6, D2-12)', () => {
  const self = ctxOf('en', { mode: 'api', me: { user: { id: 'u-ta', handle: 'tenant.admin' }, adminRoles: ['tenant_admin'] } as never });
  const ta = admin('u-ta', 'tenant.admin');
  const rina = admin('u-rina', 'rina', { adminRoles: ['tenant_admin', 'storage_admin'] });
  const bagus = member();

  it('a grant to yourself or to an administrator waits for approval; the approvers neither ask nor receive', () => {
    expect(needsApproval(self, ta)).toBe(true);
    expect(needsApproval(self, bagus)).toBe(false);
    expect(needsApproval(self, { ...bagus, adminRoles: ['storage_admin'] })).toBe(true);
    expect(needsApproval(self, { ...bagus, adminRoles: ['storage_admin'], membershipStatus: 'invited' })).toBe(false);
    const members = [ta, rina, { ...bagus, adminRoles: ['storage_admin' as const] }];
    expect(approversOf(members, { id: 'u-ta' }, bagus.id).map((m) => m.handle)).toEqual(['rina']);
    expect(approversOf(members, { id: 'u-ta' }, 'u-rina')).toEqual([]);
    expect(approversOf([...members, admin('u-off', 'off', { membershipStatus: 'disabled' })], null, bagus.id).map((m) => m.handle)).toEqual(['tenant.admin', 'rina']);
  });

  it('disable is refused for yourself and the last Tenant Admin; grants need an active person', () => {
    expect(disableBlock(self, ta, [ta, rina])).toEqual(TEXT.disableSelf);
    expect(disableBlock(self, rina, [ta, rina])).toBeNull();
    expect(disableBlock(ctxOf('en', { mode: 'api', me: { user: { id: 'u-x', handle: 'x' } } as never }), rina, [rina])).toEqual(TEXT.disableLastAdmin);
    expect(grantBlock(bagus)).toBeNull();
    expect(grantBlock({ ...bagus, membershipStatus: 'invited' })).toEqual(TEXT.grantInvited);
    expect(grantBlock({ ...bagus, membershipStatus: 'disabled' })).toEqual(TEXT.grantDisabled);
    expect(grantBlock({ ...bagus, kind: 'guest' })).toEqual(TEXT.grantGuest);
  });

  it('an invited membership cannot be disabled: the drawer says why, and the sample adapter refuses it as the api does', async () => {
    const invited = member({ id: 'u-inv', handle: 'nadia.halim', membershipStatus: 'invited', accountStatus: 'invited', roles: [], otherMemberships: false });
    expect(disableBlock(self, invited, [ta, rina, invited])).toEqual(TEXT.disableInvited);
    // Yourself first: an invited session person is told that their own membership cannot be disabled.
    expect(disableBlock(ctxOf('en', { mode: 'api', me: { user: { id: 'u-inv', handle: 'nadia.halim' } } as never }), invited, [ta, invited])).toEqual(TEXT.disableSelf);
    expect(disableBlock(self, { ...bagus, membershipStatus: 'disabled' }, [ta, rina])).toBeNull();

    const adapter = createSampleAdapter(() => D, () => 'rina');
    const refused = await adapter.update('sample-invited-1', { membershipStatus: 'disabled' });
    expect(refused).toMatchObject({ ok: false, error: { status: 400, errors: [{ path: 'body.membershipStatus', message: 'An invited membership becomes active when the user accepts it' }] } });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refusalText(ctxOf('en'), refused.error)).toBe('The change was refused: An invited membership becomes active when the user accepts it');
    expect(refusalText(ctxOf('id'), refused.error)).toBe('Perubahan ditolak: An invited membership becomes active when the user accepts it');
    const list = await adapter.members();
    expect(list.ok && list.data.find((m) => m.id === 'sample-invited-1')).toMatchObject({ membershipStatus: 'invited' });

    // The drawer shows the reason next to the disabled button, in both languages.
    const data: UsersData = { members: [invited], systems: sampleSystems(D), providers: [], tenancy: 'single' };
    for (const lang of ['en', 'id'] as Lang[]) {
      const ctx = ctxOf(lang);
      const html = render(<PersonDrawer ctx={ctx} member={invited} data={data} onClose={() => undefined} onAction={() => undefined} onRevoke={() => undefined} />, ctx);
      expect(html).toContain(TEXT.disableInvited[lang === 'id' ? 1 : 0]);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(Disable|Nonaktifkan)/);
    }
  });

  it('a refusal shows the field messages of errors[]; a refusal without them reads as before', () => {
    const en = ctxOf('en');
    const id = ctxOf('id');
    const titled = { status: 400, slug: 'validation', message: ['Invalid request', 'Invalid request'] as [string, string], errors: [{ path: 'body.membershipStatus', message: 'First' }, { path: 'body', message: 'Second' }, { path: 'body.x', message: 'First' }] };
    expect(refusalText(en, titled)).toBe('The change was refused: First; Second');
    expect(refusalText(id, titled)).toBe('Perubahan ditolak: First; Second');
    expect(refusalText(en, { ...titled, detail: 'More' })).toBe('The change was refused: More; First; Second');
    const translated = { status: 422, message: ['Not allowed.', 'Tidak diizinkan.'] as [string, string], errors: [{ path: 'body', message: 'Why' }] };
    expect(refusalText(id, translated)).toBe('Tidak diizinkan. Why');
    const plain = { status: 403, message: ['Forbidden', 'Forbidden'] as [string, string], detail: 'Another organisation' };
    expect(refusalText(en, plain)).toBe(errorText(en, plain));
    expect(refusalText(en, { ...plain, errors: [] })).toBe('Forbidden: Another organisation');
  });

  it('a change of the membership or of a listed job title reloads the snapshot; other changes leave it (D2-08)', () => {
    const grants = [
      { grantId: 'g1', ms: 'isms', role: 'domain_owner' as const, isPrimary: false, approvalStatus: 'active' as const, validUntil: null },
      { grantId: 'g2', ms: 'qms', role: 'risk_owner' as const, isPrimary: false, approvalStatus: 'pending_approval' as const, validUntil: null },
    ];
    const before = member({ roles: grants });
    // Disable: the systems of the active grants and the systems where items are held (the organisation snapshot too).
    expect(snapshotReload(before, { ...before, membershipStatus: 'disabled' }, ['isms', 'bcms'])).toEqual(['isms', 'bcms']);
    // Enable again: the systems of the active grants; a member without any still reloads the organisation snapshot.
    expect(snapshotReload({ ...before, membershipStatus: 'disabled' }, before)).toEqual(['isms']);
    expect(snapshotReload(member({ roles: [], membershipStatus: 'disabled' }), member({ roles: [] }))).toEqual([]);
    // Edit: a new job title of a member with an active role reloads the organisation snapshot only.
    expect(snapshotReload(before, { ...before, jobTitle: 'Head of IT' })).toEqual([]);
    expect(snapshotReload(before, { ...before, jobTitle: null })).toEqual([]);
    expect(snapshotReload(member({ roles: [grants[1]] }), member({ roles: [grants[1]], jobTitle: 'Head of IT' }))).toBeNull();
    expect(snapshotReload({ ...before, membershipStatus: 'disabled' }, { ...before, membershipStatus: 'disabled', jobTitle: 'Head of IT' })).toBeNull();
    expect(snapshotReload(before, { ...before, adminRoles: ['storage_admin'] })).toBeNull();
    expect(snapshotReload(before, { ...before, displayName: 'Bagus P.' })).toEqual(['isms']);
  });

  it('the job title of a member of another organisation is read-only; editPatch sends the changed fields only', () => {
    expect(jobTitleBlock(self, bagus)).toEqual(TEXT.jobLocked);
    expect(jobTitleBlock(self, { ...bagus, otherMemberships: false })).toBeNull();
    expect(jobTitleBlock(self, { ...bagus, membershipStatus: 'invited', otherMemberships: false })).toEqual(TEXT.jobInvited);
    expect(editPatch(self, { jobTitle: 'IT Infrastructure Lead', adminRoles: [] }, bagus)).toBeNull();
    expect(editPatch(self, { jobTitle: 'Other', adminRoles: ['storage_admin'] }, bagus)).toEqual({ adminRoles: ['storage_admin'] });
    expect(editPatch(self, { jobTitle: ' ', adminRoles: [] }, { ...bagus, otherMemberships: false })).toEqual({ jobTitle: null });
    expect(editPatch(self, { jobTitle: 'Lead', adminRoles: ['tenant_admin'] }, ta)).toEqual({ jobTitle: 'Lead' });
  });
});

describe('forms and bodies', () => {
  const ctx = ctxOf('en');
  it('checks and builds UserCreate', () => {
    expect(inviteErrors({ email: 'x', displayName: '', jobTitle: 'j'.repeat(151), adminRoles: [] }, 'en')).toEqual({ email: TEXT.badEmail, displayName: TEXT.required, jobTitle: 'At most 150 characters.' });
    expect(inviteErrors({ email: 'new.user@nusa.co.id', displayName: 'New User', jobTitle: '', adminRoles: [] }, 'id')).toEqual({});
    expect(inviteBody({ email: ' new.user@nusa.co.id ', displayName: ' New ', jobTitle: '', adminRoles: ['storage_admin', 'tenant_admin'] })).toEqual({ email: 'new.user@nusa.co.id', displayName: 'New', adminRoles: ['tenant_admin', 'storage_admin'] });
  });

  it('checks a grant (role, system, External Auditor end date, already held) and builds RoleGrant', () => {
    const bagus = member();
    expect(grantErrors({ ms: '', role: '', isPrimary: false, validUntil: '' }, bagus, '2026-09-28', ctx)).toEqual({ ms: TEXT.required, role: TEXT.required });
    expect(grantErrors({ ms: 'isms', role: 'external_auditor', isPrimary: false, validUntil: '' }, bagus, '2026-09-28', ctx)).toEqual({ validUntil: TEXT.required });
    expect(grantErrors({ ms: 'isms', role: 'risk_owner', isPrimary: false, validUntil: '2026-09-28' }, bagus, '2026-09-28', ctx)).toEqual({ validUntil: TEXT.futureDate });
    expect(grantErrors({ ms: 'isms', role: 'domain_owner', isPrimary: false, validUntil: '' }, bagus, '2026-09-28', ctx).role).toBe('Bagus Prasetyo already holds this role in this system.');
    expect(grantBody({ ms: 'isms', role: 'ms_manager', isPrimary: true, validUntil: '' }, bagus)).toEqual({ user: 'bagus', role: 'ms_manager', isPrimary: true });
    expect(grantBody({ ms: 'isms', role: 'external_auditor', isPrimary: true, validUntil: '2026-10-13' }, bagus)).toEqual({ user: 'bagus', role: 'external_auditor', validUntil: '2026-10-13T23:59:59Z' });
    expect(endOfDay('2026-01-02')).toBe('2026-01-02T23:59:59Z');
  });

  it('filters by search, membership, role and system', () => {
    const { members } = sampleMembers(D);
    expect(filterMembers(members, { ...EMPTY_FILTER, q: 'bagus' }).map((m) => m.handle)).toEqual(['bagus']);
    expect(filterMembers(members, { ...EMPTY_FILTER, status: 'invited' }).map((m) => m.membershipStatus)).toEqual(['invited']);
    expect(filterMembers(members, { ...EMPTY_FILTER, role: 'admin' }).map((m) => m.handle).sort()).toEqual(['rina', 'tono', 'yusuf']);
    expect(filterMembers(members, { ...EMPTY_FILTER, role: 'pending' }).map((m) => m.handle).sort()).toEqual(['rina', 'yusuf']);
    expect(filterMembers(members, { ...EMPTY_FILTER, role: 'internal_auditor', ms: 'qms' }).map((m) => m.handle)).toEqual(['maya']);
    expect(filterMembers(members, { ...EMPTY_FILTER, role: 'none' }).every((m) => !m.roles.length && !m.adminRoles.length)).toBe(true);
  });

  it('builds the roles and responsibilities CSV with formulas neutralised and a BOM', () => {
    const systems = [{ id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'ISMS', archived: false }];
    const csv = rolesCsv(
      [member({ displayName: '=Bagus', adminRoles: ['storage_admin'], roles: [{ grantId: 'g1', ms: 'isms', role: 'ms_manager', isPrimary: true, approvalStatus: 'active', validUntil: '2027-01-31T23:59:59Z' }, { grantId: 'g2', ms: 'isms', role: 'risk_owner', isPrimary: false, approvalStatus: 'pending_approval', validUntil: null }] }), member({ id: 'x', membershipStatus: 'invited' })],
      systems,
      { g1: { requestedBy: { handle: 'tenant.admin', name: 'Tenant Admin' }, requestedAt: '2026-09-01T01:00:00Z', decidedBy: { handle: 'rina', name: 'Rina, K' }, decidedAt: '2026-09-02T01:00:00Z' } },
      'en',
    );
    expect(csv.startsWith('﻿Person,Email,Role,System,Primary,Granted by,Since,Valid until\r\n')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("'=Bagus,bagus.prasetyo@nusantaradigital.co.id,Storage Admin,Whole organisation,,,,");
    expect(lines[2]).toBe("'=Bagus,bagus.prasetyo@nusantaradigital.co.id,MS Manager,ISMS,Yes,\"Rina, K\",2026-09-02,2027-01-31");
    expect(rolesCsv([], [], {}, 'id').split('\r\n')[0]).toBe('﻿Orang,Alamat email,Peran,Sistem,Utama,Diberikan oleh,Sejak,Berlaku sampai');
    expect([csvCell('+1'), csvCell('a"b'), csvCell(null), csvCell(3)]).toEqual(["'+1", '"a""b"', '', '3']);
  });
});

describe('users API adapter', () => {
  it('reads every page of members, the systems by uuid, the providers and the tenancy mode', async () => {
    const page = (n: number) => json({ items: Array.from({ length: n === 1 ? 200 : 3 }, (_, i) => ({ ...USER, id: `${n}-${i}`, handle: `u${n}x${i}` })), page: n, pageSize: 200, total: 203 });
    const f = fakeFetch({
      'GET /api/v1/admin/users': [page(1), page(2)],
      'GET /api/v1/admin/management-systems': json([{ id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'Information security', status: 'implementing' }, { id: 'x', slug: 'old', code: 'OLD', name: 'Old', status: 'archived' }]),
      'GET /api/v1/admin/identity-providers': json([{ id: 'p', slug: 'keycloak', kind: 'oidc', displayName: 'Keycloak', enabled: true }]),
      'GET /api/v1/admin/organization': json({ tenancyMode: 'multi', localLogin: 'allowed' }),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    const members = await adapter.members();
    expect(members.ok && members.data.length).toBe(203);
    expect(f.calls.map((c) => c.url)).toEqual(['/api/v1/admin/users?page=1&pageSize=200', '/api/v1/admin/users?page=2&pageSize=200']);
    expect(await adapter.systems()).toEqual({ ok: true, data: [{ id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'Information security', archived: false }, { id: 'x', slug: 'old', code: 'OLD', name: 'Old', archived: true }] });
    expect(await adapter.providers()).toEqual({ ok: true, data: [{ slug: 'keycloak', name: 'Keycloak', kind: 'oidc', enabled: true }] });
    expect(await adapter.org()).toEqual({ ok: true, data: { tenancyMode: 'multi' } });
  });

  it('invites with the Idempotency-Key and keeps the LIC-USERS refusal with its message', async () => {
    const limit = problem(422, 'business-rule', { rule: 'LIC-USERS', messageKey: 'licence.max_users', messages: { en: 'The plan of this organisation allows 5 active users and the organisation already has 5. Ask your MSCD service provider for a plan with more users.', id: 'Paket organisasi ini mengizinkan 5 pengguna aktif.' } });
    const f = fakeFetch({ 'POST /api/v1/admin/users': [json({ status: 'invited' }, 202), limit] });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const body = { email: 'new.user@nusa.co.id', displayName: 'New User', adminRoles: [] };
    expect(await adapter.invite(body, 'key-1')).toEqual({ ok: true, data: null, message: null });
    expect(f.calls[0]).toMatchObject({ method: 'POST', body, headers: { 'idempotency-key': 'key-1', 'x-csrf-token': 'csrf-token-0123456789abcdef' } });
    const refused = await adapter.invite(body, 'key-2');
    if (refused.ok) throw new Error('expected LIC-USERS');
    expect(isUserLimit(refused.error)).toBe(true);
    expect(refused.error.message[0]).toContain('MSCD service provider');
  });

  it('updates, grants by system uuid, decides, revokes, reads holdings, registers an identity and resets the factor', async () => {
    const f = fakeFetch({
      [`PATCH /api/v1/admin/users/${USER.id}`]: [json({ ...USER, adminRoles: ['storage_admin'] }), problem(400, 'validation', { errors: [{ path: 'body', message: 'The organisation needs at least one active Tenant Admin' }] })],
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles`]: json({ ok: true, changed: ['isms'], message: ['No other Tenant Admin can approve this grant yet; it stays pending until one does', 'Belum ada Tenant Admin lain'], data: { approvalStatus: 'pending_approval', grantId: GRANT_ID } }, 201),
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/approve`]: problem(422, 'business-rule', { rule: 'SOD-SELF-GRANT', messages: { en: 'A role grant is approved or rejected by a Tenant Admin who neither requested it nor receives it', id: 'x' } }),
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/reject`]: json({ ok: true, changed: ['isms'], data: { approvalStatus: 'rejected' } }),
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/revoke`]: { status: 204 },
      [`GET /api/v1/admin/users/${USER.id}/holdings`]: json({ systems: [{ ms: 'isms', name: 'ISMS', primaryManager: { handle: 'rina', displayName: 'Rina Kusuma', email: 'rina@x.id' }, counts: { risk: 3, evidence: 2 }, total: 5 }] }),
      [`POST /api/v1/admin/users/${USER.id}/identities`]: [json({ ok: true, changed: [] }, 201), problem(409, 'conflict', { detail: 'This subject is already linked to an account' })],
      [`POST /api/v1/admin/users/${USER.id}/reset-mfa`]: [{ status: 204 }, problem(403, 'forbidden', { detail: "The user is a member of another organisation: only the platform operator resets the second factor" })],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const system = { id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'ISMS', archived: false };
    expect(await adapter.update(USER.id, { adminRoles: ['storage_admin'] })).toMatchObject({ ok: true, data: { adminRoles: ['storage_admin'] } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { adminRoles: ['storage_admin'] } });
    expect(await adapter.update(USER.id, { adminRoles: [] })).toMatchObject({ ok: false, error: { status: 400, errors: [{ path: 'body' }] } });
    const granted = await adapter.grant(system, { user: 'bagus', role: 'risk_owner' }, 'grant-key');
    expect(granted).toEqual({ ok: true, data: { approvalStatus: 'pending_approval', grantId: GRANT_ID }, message: ['No other Tenant Admin can approve this grant yet; it stays pending until one does', 'Belum ada Tenant Admin lain'] });
    expect(f.calls.at(-1)).toMatchObject({ body: { user: 'bagus', role: 'risk_owner' }, headers: { 'idempotency-key': 'grant-key' } });
    expect(await adapter.approve(system, GRANT_ID)).toMatchObject({ ok: false, error: { status: 422, rule: 'SOD-SELF-GRANT' } });
    expect(await adapter.reject(system, GRANT_ID)).toMatchObject({ ok: true });
    expect(await adapter.revoke(system, GRANT_ID)).toMatchObject({ ok: true });
    expect(await adapter.holdings(USER.id)).toEqual({ ok: true, data: [{ ms: 'isms', name: 'ISMS', primaryManager: { handle: 'rina', displayName: 'Rina Kusuma', email: 'rina@x.id' }, counts: { risk: 3, evidence: 2 }, total: 5 }] });
    expect(await adapter.registerIdentity(USER.id, { provider: 'keycloak', subject: 's-1' }, 'id-key')).toMatchObject({ ok: true });
    expect(f.calls.at(-1)).toMatchObject({ body: { provider: 'keycloak', subject: 's-1' }, headers: { 'idempotency-key': 'id-key' } });
    expect(await adapter.registerIdentity(USER.id, { provider: 'keycloak', subject: 's-1' }, 'id-key')).toMatchObject({ ok: false, error: { status: 409, detail: 'This subject is already linked to an account' } });
    expect(await adapter.resetMfa(USER.id)).toMatchObject({ ok: true });
    expect(await adapter.resetMfa(USER.id)).toMatchObject({ ok: false, error: { status: 403 } });
    for (const call of f.calls.filter((c) => c.method !== 'GET')) expect(call.headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
  });

  it('reads who asked for and who decided on grants from the audit trail metadata', async () => {
    const entry = (action: string, handle: string, at: string, entityId = GRANT_ID) => ({ seq: 1, occurredAt: at, actor: { handle, displayName: handle.toUpperCase(), kind: 'user' }, action, entityType: 'user_ms_role', entityId });
    const f = fakeFetch({
      'GET /api/v1/admin/audit-trail': [
        json({ items: [entry('role.grant_approved', 'rina', '2026-09-03T00:00:00Z'), entry('role.grant_requested', 'tenant.admin', '2026-09-02T00:00:00Z'), entry('role.granted', 'rina', '2026-08-01T00:00:00Z', 'other')], page: 1, pageSize: 200, total: 3 }),
        json({ items: [entry('role.grant_requested', 'tenant.admin', '2026-09-02T00:00:00Z')], page: 1, pageSize: 50, total: 1 }),
      ],
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    expect(await adapter.history(null)).toEqual({
      ok: true,
      data: {
        [GRANT_ID]: { requestedBy: { handle: 'tenant.admin', name: 'TENANT.ADMIN' }, requestedAt: '2026-09-02T00:00:00Z', decidedBy: { handle: 'rina', name: 'RINA' }, decidedAt: '2026-09-03T00:00:00Z' },
        other: { requestedBy: null, requestedAt: null, decidedBy: { handle: 'rina', name: 'RINA' }, decidedAt: '2026-08-01T00:00:00Z' },
      },
    });
    expect(f.calls[0].url).toBe('/api/v1/admin/audit-trail?entityType=user_ms_role&page=1&pageSize=200');
    await adapter.history([GRANT_ID]);
    expect(f.calls[1].url).toBe(`/api/v1/admin/audit-trail?entityType=user_ms_role&entityId=${GRANT_ID}&pageSize=50`);
    expect(historyOf([])).toEqual({});
  });
});

describe('a change of your own roles renews the session (F.1)', () => {
  const SELF: UserView = {
    ...USER, id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b', handle: 'tenant.admin', email: 'tenant.admin@mscd.test', displayName: 'Tenant Admin', jobTitle: 'IT Administrator',
    adminRoles: ['tenant_admin'], roles: [], otherMemberships: false,
  };
  const BEFORE = { user: { id: SELF.id, handle: 'tenant.admin' }, adminRoles: ['tenant_admin'], rolesByMs: {} as Record<string, string[]>, uiRoleByMs: {} as Record<string, string>, platformRoles: [] };
  const meAnswer = (over: Record<string, unknown> = {}) => json({
    user: { id: SELF.id, handle: 'tenant.admin', email: SELF.email, displayName: SELF.displayName, jobTitle: SELF.jobTitle },
    org: { id: 'o-1', slug: 'tst', name: 'Test Organisation' }, orgs: [], rolesByMs: {}, uiRoleByMs: {}, adminRoles: ['tenant_admin', 'storage_admin'], platformRoles: [],
    permissions: { org: ['user.manage'], ms: {} }, csrfToken: 'csrf-renewed-0123456789abcdef',
    session: { authMethod: 'local', idleExpiresAt: '2026-10-29T10:00:00Z', absoluteExpiresAt: '2026-10-29T20:00:00Z' }, preferences: {}, pendingMemberships: [],
    ...over,
  });
  const apiCtx = (client: ApiClient, me: Record<string, unknown> = BEFORE) => ctxOf('en', { mode: 'api', client, me: me as never });
  const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);

  it('an Edit of your own administration roles reads GET /me before the next write, which carries the new CSRF token', async () => {
    const f = fakeFetch({
      [`PATCH /api/v1/admin/users/${SELF.id}`]: [json({ ...SELF, adminRoles: ['tenant_admin', 'storage_admin'] }), json({ ...SELF, adminRoles: ['tenant_admin', 'storage_admin'], jobTitle: 'Head of IT' })],
      [`PATCH /api/v1/admin/users/${USER.id}`]: json({ ...USER, adminRoles: ['storage_admin'] }),
      'GET /api/v1/me': meAnswer(),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-before-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const ctx = apiCtx(client);
    const first = await saveEdit(ctx, adapter, fromUserView(SELF), { adminRoles: ['tenant_admin', 'storage_admin'] });
    if (!first.ok) throw new Error('the first save failed');
    // Adding Storage Admin to a Tenant Admin changes nothing the shell read from Me: a snapshot reload carries it.
    expect(first.data).toMatchObject({ renewal: 'reload', member: { adminRoles: ['tenant_admin', 'storage_admin'] } });
    expect(sent(f.calls)).toEqual([`PATCH /api/v1/admin/users/${SELF.id}`, 'GET /api/v1/me']);
    // The second change in the same page: only the job title, so no new session and no GET /me.
    expect(await saveEdit(ctx, adapter, first.data.member, { jobTitle: 'Head of IT' })).toMatchObject({ ok: true, data: { renewal: 'none', member: { jobTitle: 'Head of IT' } } });
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-before-0123456789abcdef');
    expect(f.calls[2]).toMatchObject({ method: 'PATCH', headers: { 'x-csrf-token': 'csrf-renewed-0123456789abcdef' } });
    // The administration roles of another member renew nothing.
    expect(await saveEdit(ctx, adapter, member(), { adminRoles: ['storage_admin'] })).toMatchObject({ ok: true, data: { renewal: 'none' } });
    expect(sent(f.calls).filter((c) => c === 'GET /api/v1/me')).toHaveLength(1);
  });

  it('revoking your own grant reads GET /me; the grant of another member does not', async () => {
    const f = fakeFetch({
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/revoke`]: { status: 204 },
      'GET /api/v1/me': [meAnswer({ adminRoles: ['tenant_admin'] }), meAnswer({ adminRoles: ['tenant_admin'], rolesByMs: { isms: ['internal_auditor'] }, uiRoleByMs: { isms: 'auditor' } })],
      [`PATCH /api/v1/admin/users/${SELF.id}`]: json({ ...SELF, jobTitle: 'Head of IT' }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-before-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const system = { id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'ISMS', archived: false };
    const grant = { grantId: GRANT_ID, ms: 'isms', role: 'ms_manager' as const, isPrimary: true, approvalStatus: 'active' as const, validUntil: null };
    const self = fromUserView({ ...SELF, roles: [grant] });
    // The only role in ISMS: the system leaves the snapshot's system list, so a snapshot reload is enough.
    const only = apiCtx(client, { ...BEFORE, rolesByMs: { isms: ['ms_manager'] }, uiRoleByMs: { isms: 'manager' } });
    expect(await revokeGrant(only, adapter, system, self, grant)).toEqual({ ok: true, data: 'reload', message: null });
    expect(sent(f.calls)).toEqual([`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/revoke`, 'GET /api/v1/me']);
    expect(await saveEdit(only, adapter, self, { jobTitle: 'Head of IT' })).toMatchObject({ ok: true });
    expect(f.calls[2].headers['x-csrf-token']).toBe('csrf-renewed-0123456789abcdef');
    // One of two roles in ISMS: the UI role there changes, which the shell read from Me, so the app loads again.
    const two = apiCtx(client, { ...BEFORE, rolesByMs: { isms: ['ms_manager', 'internal_auditor'] }, uiRoleByMs: { isms: 'manager' } });
    expect(await revokeGrant(two, adapter, system, self, grant)).toMatchObject({ ok: true, data: 'restart' });
    const reads = sent(f.calls).filter((c) => c === 'GET /api/v1/me').length;
    expect(await revokeGrant(two, adapter, system, member({ roles: [grant] }), grant)).toMatchObject({ ok: true, data: 'none' });
    expect(await revokeGrant(two, adapter, system, member({ roles: [grant] }), { ...grant, approvalStatus: 'pending_approval' })).toMatchObject({ ok: true, data: 'none' });
    expect(sent(f.calls).filter((c) => c === 'GET /api/v1/me')).toHaveLength(reads);
  });

  it('revoking your own grant the page still lists as waiting reads GET /me before the next write, which carries the new CSRF token', async () => {
    // Another Tenant Admin approved the grant after the page loaded: the server revokes an active role and renews the
    // session, while the page still lists the grant as waiting. GET /me finds the roles the shell read (the grant was
    // never in Me), so a snapshot reload carries the change.
    const f = fakeFetch({
      [`POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/revoke`]: { status: 204 },
      'GET /api/v1/me': meAnswer({ adminRoles: ['tenant_admin'] }),
      [`PATCH /api/v1/admin/users/${USER.id}`]: json({ ...USER, adminRoles: ['storage_admin'] }),
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-before-0123456789abcdef');
    const adapter = createApiAdapter(client);
    const system = { id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'ISMS', archived: false };
    const waiting = { grantId: GRANT_ID, ms: 'isms', role: 'risk_owner' as const, isPrimary: false, approvalStatus: 'pending_approval' as const, validUntil: null };
    const self = fromUserView({ ...SELF, roles: [waiting] });
    const ctx = apiCtx(client);
    expect(await revokeGrant(ctx, adapter, system, self, waiting)).toEqual({ ok: true, data: 'reload', message: null });
    expect(await saveEdit(ctx, adapter, member(), { adminRoles: ['storage_admin'] })).toMatchObject({ ok: true, data: { renewal: 'none' } });
    expect(sent(f.calls)).toEqual([
      `POST /api/v1/admin/management-systems/${ISMS_ID}/roles/${GRANT_ID}/revoke`,
      'GET /api/v1/me',
      `PATCH /api/v1/admin/users/${USER.id}`,
    ]);
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-before-0123456789abcdef');
    expect(f.calls[2].headers['x-csrf-token']).toBe('csrf-renewed-0123456789abcdef');
  });

  it('the Revoke dialog reads the current state of a grant the page lists as waiting', async () => {
    const waiting = { grantId: GRANT_ID, ms: 'isms', role: 'risk_owner' as const, isPrimary: false, approvalStatus: 'pending_approval' as const, validUntil: null };
    const approved = { ...waiting, approvalStatus: 'active' as const };
    const self = fromUserView({ ...SELF, roles: [waiting] });
    // The api adapter: the member list narrowed by the email, then the member by id and the grant by id.
    const f = fakeFetch({
      'GET /api/v1/admin/users': [
        json({ items: [{ ...SELF, roles: [approved] }, { ...USER, email: 'tenant.admin@mscd.test.example' }], page: 1, pageSize: 200, total: 2 }),
        json({ items: [{ ...SELF, roles: [] }], page: 1, pageSize: 200, total: 1 }),
        problem(503, 'unavailable'),
      ],
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    expect(await adapter.currentGrant(self, GRANT_ID)).toEqual({ ok: true, data: approved });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: '/api/v1/admin/users?q=tenant.admin%40mscd.test&page=1&pageSize=200' });
    expect(await adapter.currentGrant(self, GRANT_ID)).toEqual({ ok: true, data: null });
    expect(await adapter.currentGrant(self, GRANT_ID)).toMatchObject({ ok: false, error: { status: 503 } });
    // `q` takes at most 100 characters.
    const empty = fakeFetch({ 'GET /api/v1/admin/users': json({ items: [], page: 1, pageSize: 200, total: 0 }) });
    expect(await createApiAdapter(new ApiClient({ fetch: empty.fetch })).currentGrant({ ...self, email: `${'a'.repeat(120)}@mscd.test` }, GRANT_ID)).toEqual({ ok: true, data: null });
    expect(new URL(empty.calls[0].url, 'http://localhost').searchParams.get('q')).toBe('a'.repeat(100));

    // What the dialog shows: the page's state until the read answers, then the server's; a failed read keeps the page's.
    const target = { member: self, grant: waiting };
    expect(needsGrantRead(target)).toBe(true);
    expect(needsGrantRead({ member: self, grant: approved })).toBe(false);
    expect(needsGrantRead(null)).toBe(false);
    expect(currentGrantOf(null, null)).toEqual({ grant: null, checking: false });
    expect(currentGrantOf({ member: self, grant: approved }, null)).toEqual({ grant: approved, checking: false });
    expect(currentGrantOf(target, null)).toEqual({ grant: waiting, checking: true });
    expect(currentGrantOf(target, { target: { ...target }, grant: approved })).toEqual({ grant: waiting, checking: true });
    expect(currentGrantOf(target, { target, grant: approved })).toEqual({ grant: approved, checking: false });
    expect(currentGrantOf(target, { target, grant: null })).toEqual({ grant: waiting, checking: false });

    // The sample adapter answers from its people: a waiting grant approved by another Tenant Admin reads active.
    let me = 'tono';
    const sample = createSampleAdapter(() => D, () => me);
    const isms = sampleSystems(D)[0];
    const asked = await sample.grant(isms, { user: 'rina', role: 'risk_owner' }, 'k');
    if (!asked.ok) throw new Error('grant failed');
    const rina = sampleMembers(D).members.find((m) => m.handle === 'rina')!;
    expect(await sample.currentGrant(rina, asked.data.grantId)).toMatchObject({ ok: true, data: { approvalStatus: 'pending_approval' } });
    me = 'yusuf';
    expect(await sample.approve(isms, asked.data.grantId)).toMatchObject({ ok: true });
    expect(await sample.currentGrant(rina, asked.data.grantId)).toMatchObject({ ok: true, data: { grantId: asked.data.grantId, approvalStatus: 'active' } });
    expect(await sample.currentGrant(rina, 'gone')).toEqual({ ok: true, data: null, message: null });
  });

  it('a failed GET /me loads the app again (the token may be the old one); the sample build renews nothing', async () => {
    const f = fakeFetch({ 'GET /api/v1/me': 'network-error' });
    expect(await renewSession(apiCtx(new ApiClient({ fetch: f.fetch })), createApiAdapter(new ApiClient({ fetch: f.fetch })))).toBe('restart');
    expect(await renewSession(ctxOf('en'), createSampleAdapter(() => D, () => 'rina'))).toBe('none');
    const rina = sampleMembers(D).members.find((m) => m.handle === 'rina')!;
    expect(await saveEdit(ctxOf('en'), createSampleAdapter(() => D, () => 'rina'), rina, { adminRoles: ['tenant_admin'] })).toMatchObject({ ok: true, data: { renewal: 'none' } });
  });

  it('decides which changes renew the session and when the app must load again', () => {
    const ctx = ctxOf('en', { mode: 'api', me: BEFORE as never });
    const self = fromUserView(SELF);
    expect(renewsOnEdit(ctx, self, { adminRoles: ['storage_admin', 'tenant_admin'] })).toBe(true);
    expect(renewsOnEdit(ctx, self, { adminRoles: ['tenant_admin'] })).toBe(false);
    expect(renewsOnEdit(ctx, self, { jobTitle: 'x' })).toBe(false);
    expect(renewsOnEdit(ctx, member(), { adminRoles: ['storage_admin'] })).toBe(false);
    const grant = { grantId: 'g', ms: 'isms', role: 'risk_owner' as const, isPrimary: false, approvalStatus: 'active' as const, validUntil: null };
    // Every revocation of your own grant renews: the page may list as waiting a grant the server holds as active.
    expect(renewsOnRevoke(ctx, self)).toBe(true);
    expect(renewsOnRevoke(ctx, member())).toBe(false);
    // The dialog's note on your session follows the state the dialog knows.
    expect(revokesOwnRole(ctx, self, grant)).toBe(true);
    expect(revokesOwnRole(ctx, self, { approvalStatus: 'pending_approval' })).toBe(false);
    expect(revokesOwnRole(ctx, member(), grant)).toBe(false);

    const roles = (adminRoles: string[], rolesByMs: Record<string, string[]> = {}, uiRoleByMs: Record<string, string> = {}) => ({ adminRoles, rolesByMs, uiRoleByMs });
    expect(sessionRestart(roles(['tenant_admin']), roles(['tenant_admin', 'storage_admin']))).toBe(false);
    expect(sessionRestart(roles(['tenant_admin', 'storage_admin']), roles(['tenant_admin']))).toBe(false);
    expect(sessionRestart(roles(['tenant_admin']), roles(['storage_admin']))).toBe(true);
    expect(sessionRestart(roles(['storage_admin']), roles(['storage_admin', 'tenant_admin']))).toBe(true);
    expect(sessionRestart(roles(['storage_admin']), roles([]))).toBe(true);
    expect(sessionRestart(roles([], { isms: ['ms_manager'] }, { isms: 'manager' }), roles([]))).toBe(false);
    expect(sessionRestart(roles([], { isms: ['ms_manager'], qms: ['risk_owner'] }, { isms: 'manager', qms: 'owner' }), roles([], { qms: ['risk_owner'] }, { qms: 'owner' }))).toBe(false);
    expect(sessionRestart(roles([], { isms: ['ms_manager', 'risk_owner'] }, { isms: 'manager' }), roles([], { isms: ['risk_owner'] }, { isms: 'owner' }))).toBe(true);
    expect(sessionRestart(null, roles([]))).toBe(false);
    expect(sessionRolesOf({ adminRoles: ['tenant_admin'], rolesByMs: { isms: ['ms_manager'] }, uiRoleByMs: { isms: 'manager' } })).toEqual(roles(['tenant_admin'], { isms: ['ms_manager'] }, { isms: 'manager' }));
  });

  for (const lang of ['en', 'id'] as Lang[]) {
    it(`the Edit and Revoke dialogs of your own roles say that the session is renewed (${lang})`, () => {
      const ctx = ctxOf(lang, { mode: 'api', me: BEFORE as never });
      const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
      const adapter = createSampleAdapter(() => D, () => 'rina');
      const grant = { grantId: 'g', ms: 'isms', role: 'risk_owner' as const, isPrimary: false, approvalStatus: 'active' as const, validUntil: null };
      const self = fromUserView({ ...SELF, roles: [grant] });
      const systems = [{ id: ISMS_ID, slug: 'isms', code: 'ISMS', name: 'ISMS', archived: false }];
      expect(render(<EditDialog ctx={ctx} adapter={adapter} member={self} members={[self]} onClose={() => undefined} onSaved={() => undefined} />, ctx)).toContain(t(TEXT.ownAdminWarning));
      expect(render(<RevokeDialog ctx={ctx} adapter={adapter} target={{ member: self, grant }} systems={systems} onClose={() => undefined} onRevoked={() => undefined} />, ctx, 'dark')).toContain(t(TEXT.revokeOwn));
      // A waiting grant: the dialog says it checks the current state (another Tenant Admin may have approved it since).
      const waiting = render(<RevokeDialog ctx={ctx} adapter={adapter} target={{ member: self, grant: { ...grant, approvalStatus: 'pending_approval' } }} systems={systems} onClose={() => undefined} onRevoked={() => undefined} />, ctx);
      expect(waiting).not.toContain(t(TEXT.revokeOwn));
      expect(waiting).toContain(t(TEXT.grantChecking));
      expect(waiting).toContain(t(TEXT.revokePending));
      expect(render(<RevokeDialog ctx={ctx} adapter={adapter} target={{ member: member({ roles: [grant] }), grant }} systems={systems} onClose={() => undefined} onRevoked={() => undefined} />, ctx)).not.toContain(t(TEXT.revokeOwn));
    });
  }
});

describe('users sample adapter', () => {
  it('lists the sample people with admin roles, an invited person and two grants waiting for approval', () => {
    const { members } = sampleMembers(D);
    expect(members.find((m) => m.handle === 'rina')).toMatchObject({ adminRoles: ['tenant_admin', 'storage_admin'], email: 'rina.kusuma@nusantaradigital.co.id' });
    expect(members.filter((m) => m.membershipStatus === 'invited')).toHaveLength(1);
    expect(members.flatMap((m) => m.roles).filter((g) => g.approvalStatus === 'pending_approval')).toHaveLength(2);
    expect(members.find((m) => m.handle === 'sari')!.roles.find((g) => g.ms === 'qms')).toMatchObject({ role: 'ms_manager', isPrimary: true });
    expect(sampleEmail('Dewi Anggraini')).toBe('dewi.anggraini@nusantaradigital.co.id');
    expect(handleOfEmail('9x@y.z')).toBe('u9x');
    expect(sampleSystems(D).map((s) => s.code)).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS']);
    expect(sampleUserHoldings(D, 'bagus').map((s) => s.ms)).toEqual(['isms', 'bcms']);
  });

  it('keeps the four-eyes rule: a grant to an administrator waits, the requester and the grantee cannot decide', async () => {
    let me = 'tono';
    const adapter = createSampleAdapter(() => D, () => me);
    const system = sampleSystems(D)[0];
    const plain = await adapter.grant(system, { user: 'bagus', role: 'risk_owner' }, 'k');
    expect(plain).toMatchObject({ ok: true, data: { approvalStatus: 'active' } });
    const toAdmin = await adapter.grant(system, { user: 'rina', role: 'risk_owner' }, 'k');
    if (!toAdmin.ok) throw new Error('grant failed');
    expect(toAdmin.data.approvalStatus).toBe('pending_approval');
    expect(await adapter.approve(system, toAdmin.data.grantId)).toMatchObject({ ok: false, error: { status: 422, rule: 'SOD-SELF-GRANT' } });
    me = 'rina';
    expect(await adapter.approve(system, toAdmin.data.grantId)).toMatchObject({ ok: false, error: { rule: 'SOD-SELF-GRANT' } });
    me = 'yusuf';
    expect(await adapter.approve(system, toAdmin.data.grantId)).toMatchObject({ ok: true });
    expect(await adapter.approve(system, toAdmin.data.grantId)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapter.grant(system, { user: 'rina', role: 'risk_owner' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    const history = await adapter.history([toAdmin.data.grantId]);
    expect(history.ok && history.data[toAdmin.data.grantId]).toMatchObject({ requestedBy: { handle: 'tono' }, decidedBy: { handle: 'yusuf' } });
  });

  it('invites, edits, disables (never yourself or the last Tenant Admin), revokes, registers and resets', async () => {
    const adapter = createSampleAdapter(() => D, () => 'rina', () => 'multi');
    expect(await adapter.org()).toEqual({ ok: true, data: { tenancyMode: 'multi' }, message: null });
    expect(await adapter.invite({ email: 'new.person@nusa.co.id', displayName: 'New', adminRoles: ['storage_admin'] }, 'k')).toMatchObject({ ok: true });
    const list = await adapter.members();
    if (!list.ok) throw new Error('members failed');
    expect(list.data.find((m) => m.email === 'new.person@nusa.co.id')).toMatchObject({ membershipStatus: 'invited', adminRoles: ['storage_admin'] });
    expect(await adapter.update('rina', { membershipStatus: 'disabled' })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await adapter.update('bagus', { jobTitle: 'Lead' })).toMatchObject({ ok: true, data: { jobTitle: 'Lead' } });
    expect(await adapter.update('maya', { jobTitle: 'Lead' })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await adapter.update('tono', { adminRoles: [] })).toMatchObject({ ok: true });
    expect(await adapter.update('rina', { adminRoles: [] })).toMatchObject({ ok: false, error: { status: 400 } });
    expect(await adapter.update('dewi', { membershipStatus: 'disabled' })).toMatchObject({ ok: true, data: { membershipStatus: 'disabled' } });
    const bagus = list.data.find((m) => m.handle === 'bagus')!;
    const grant = bagus.roles[0];
    expect(await adapter.revoke(sampleSystems(D).find((s) => s.slug === grant.ms)!, grant.grantId)).toMatchObject({ ok: true });
    expect(await adapter.registerIdentity('bagus', { provider: 'entra', subject: 's' }, 'k')).toMatchObject({ ok: true });
    expect(await adapter.registerIdentity('bagus', { provider: 'nope', subject: 's' }, 'k')).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await adapter.resetMfa('hendra')).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await adapter.resetMfa('bagus')).toMatchObject({ ok: true });
    expect(await adapter.holdings('bagus')).toMatchObject({ ok: true, data: [{ ms: 'isms' }, { ms: 'bcms' }] });
  });

  it('the build chooses the adapter; a deferred adapter retries a failed module load; settled never rejects', async () => {
    const ctx = ctxOf('en');
    expect(await adapterFor(() => ctx).systems()).toMatchObject({ ok: true });
    expect([tenancyOf(ctx), tenancyOf(ctxOf('en', { org: { id: 'x', name: 'x', ms: [], deploy: 'saas', sites: 1 } }))]).toEqual(['single', 'multi']);
    const load = vi.fn<() => Promise<UsersAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(() => D, () => 'rina'));
    const adapter = deferredAdapter(load);
    await expect(adapter.members()).rejects.toThrow('chunk');
    expect(await adapter.members()).toMatchObject({ ok: true });
    expect(await settled(Promise.reject(new Error('x')))).toMatchObject({ ok: false, error: { status: 0 } });
    const loaded = await loadUsers(createSampleAdapter(() => D, () => 'rina'), ctx);
    expect(loaded.data).toMatchObject({ tenancy: 'single' });
    expect(loaded.data!.providers.map((p) => p.slug)).toEqual(['entra', 'adfs']);
  });
});

describe('users views', () => {
  async function dataOf(): Promise<UsersData> {
    const loaded = await loadUsers(createSampleAdapter(() => D, () => 'rina'), ctxOf('en'));
    return loaded.data!;
  }

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the table, filters, drawer and dialogs in ${lang}, ${theme} theme`, async () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const data = await dataOf();
        const adapter = createSampleAdapter(() => D, () => 'rina');
        const table = render(<><Filters filter={EMPTY_FILTER} systems={data.systems} onChange={() => undefined} /><MembersTable ctx={ctx} members={data.members} systems={data.systems} onOpen={() => undefined} /></>, ctx, theme);
        for (const p of [TEXT.colName, TEXT.colJob, TEXT.colAdmin, TEXT.colRoles, TEXT.colStatus, TEXT.colMfa, TEXT.colLastSignIn, TEXT.searchLabel, TEXT.filterStatus, TEXT.filterRole, TEXT.filterSystem, TEXT.you, TEXT.statusInvited, TEXT.pending, TEXT.mfaMissing]) {
          expect(table, p[0]).toContain(t(p));
        }
        expect(table).toContain(lang === 'id' ? 'Manajer SM di ISMS' : 'MS Manager in ISMS');
        const yusuf = data.members.find((m) => m.handle === 'yusuf')!;
        const drawer = render(<PersonDrawer ctx={ctx} member={yusuf} data={data} onClose={() => undefined} onAction={() => undefined} onRevoke={() => undefined} />, ctx, theme);
        for (const p of [TEXT.drawerCrumb, TEXT.handle, TEXT.businessRoles, TEXT.actions, TEXT.edit, TEXT.grant, TEXT.revoke, TEXT.preRegister, TEXT.resetMfa, TEXT.disable, TEXT.otherOrgsNo]) expect(drawer, p[0]).toContain(t(p));
        const forms = [
          render(<InviteDialog ctx={ctx} adapter={adapter} open tenancy="single" onClose={() => undefined} onInvited={() => undefined} />, ctx, theme),
          render(<EditDialog ctx={ctx} adapter={adapter} member={yusuf} members={data.members} onClose={() => undefined} onSaved={() => undefined} />, ctx, theme),
          render(<GrantDialog ctx={ctx} adapter={adapter} member={yusuf} members={data.members} systems={data.systems} onClose={() => undefined} onGranted={() => undefined} />, ctx, theme),
          render(<RevokeDialog ctx={ctx} adapter={adapter} target={{ member: yusuf, grant: yusuf.roles[0] }} systems={data.systems} onClose={() => undefined} onRevoked={() => undefined} />, ctx, theme),
          render(<PreRegisterDialog ctx={ctx} adapter={adapter} member={yusuf} providers={data.providers} onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
          render(<ResetDialog ctx={ctx} adapter={adapter} member={{ ...yusuf, otherMemberships: true }} onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
          render(<DisableDialog ctx={ctx} adapter={adapter} member={yusuf} tenancy="single" onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
          render(<DisableDialog ctx={ctx} adapter={adapter} member={{ ...yusuf, membershipStatus: 'disabled' }} tenancy="single" onClose={() => undefined} onDone={() => undefined} />, ctx, theme),
        ];
        const all = forms.join('');
        for (const p of [TEXT.inviteTitle, TEXT.email, TEXT.displayName, TEXT.adminRoles, TEXT.sendInvite, TEXT.editSub, TEXT.system, TEXT.role, TEXT.validUntil, TEXT.approvalNeededAdmin, TEXT.revokeConfirm, TEXT.provider, TEXT.subject, TEXT.resetConfirm, TEXT.resetOtherOrg, TEXT.disableConfirm, TEXT.enableConfirm]) {
          expect(all, p[0]).toContain(t(p).split('{')[0].trim());
        }
        expect(forms.every((f) => /role="dialog"/.test(f))).toBe(true);
        expect(table + drawer + all).not.toMatch(/[—·]/);
      });
    }
  }

  it('the approval note names the approvers, or warns that the organisation has a single administrator (D2-12)', async () => {
    const ctx = ctxOf('en', { mode: 'api', me: { user: { id: 'u-ta', handle: 'tenant.admin' }, adminRoles: ['tenant_admin'] } as never });
    const ta = admin('u-ta', 'tenant.admin', { displayName: 'Tenant Admin' });
    const rina = admin('u-rina', 'rina', { displayName: 'Rina Kusuma' });
    const bagus = member({ adminRoles: ['storage_admin'] });
    expect(render(<ApprovalNote ctx={ctx} member={bagus} members={[ta, rina, bagus]} />, ctx)).toContain('Who can approve: Rina Kusuma');
    expect(render(<ApprovalNote ctx={ctx} member={ta} members={[ta, bagus]} />, ctx)).toContain(TEXT.singleAdmin[0]);
    expect(render(<ApprovalNote ctx={ctx} member={member()} members={[ta]} />, ctx)).toBe('<div class="mscd" data-theme="light"></div>');
  });

  it('the user limit names the plan and the service provider (multi tenancy) or the licence (single tenancy)', () => {
    const error = { status: 422, rule: 'LIC-USERS', message: ['The licence allows 150 active users and this organisation already has 150.', 'Lisensi mengizinkan 150 pengguna aktif.'] as [string, string] };
    const saas = render(<LimitAlert ctx={ctxOf('en')} error={error} tenancy="multi" />, ctxOf('en'));
    expect(saas).toContain(TEXT.limitTitle[0]);
    expect(saas).toContain(TEXT.limitSaas[0]);
    expect(saas).not.toContain(TEXT.openLicence[0]);
    const onPrem = render(<LimitAlert ctx={ctxOf('id')} error={error} tenancy="single" />, ctxOf('id'));
    expect(onPrem).toContain(TEXT.limitOnPrem[1]);
    expect(onPrem).toContain(TEXT.openLicence[1]);
  });

  it('a system with open items shows the counts per kind, the primary manager and the Handover link', () => {
    const ctx = ctxOf('en');
    const html = render(<SystemHoldings ctx={ctx} member={member()} system={{ ms: 'isms', name: 'ISMS', primaryManager: { handle: 'sari', displayName: 'Sari W', email: 'sari@x.id' }, counts: { risk: 3, evidence: 2 }, total: 5 }} onHandover={() => undefined} />, ctx);
    for (const text of ['5 open items', 'Risks: 3', 'Evidence: 2', 'Primary MS Manager: Sari W (sari@x.id)', 'Ask Sari W to move these items', TEXT.openHandover[0]]) expect(html).toContain(text);
    expect(grantText(ctx, { grantId: 'g', ms: 'isms', role: 'external_auditor', isPrimary: false, approvalStatus: 'active', validUntil: '2026-10-13T23:59:59Z' }, [])).toMatch(/^External Auditor in ISMS, until /);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(TEXT)) {
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[—·]/);
    }
  });

  it('is in the Administration group with user.manage after Licence, with Invite person and the export', () => {
    expect(screen).toMatchObject({ id: 'users', path: '/admin/users', group: 'admin', scope: 'org', perm: 'user.manage' });
    expect(screen.order).toBeGreaterThan(30);
    const ctx = ctxOf('id');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label[1])).toEqual(['Undang orang', 'Ekspor peran dan tanggung jawab']);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('users', { params: { invite: expect.any(Number) } });
    actions[1].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('users', { params: { exportAt: expect.any(Number) } });
  });
});
