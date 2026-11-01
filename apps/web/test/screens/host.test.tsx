// Host glue of the controller (MILESTONE-2 C.3 to C.5): who may open a host screen, how the sidebar merges host
// screens into the built-in groups, the header values of an open host screen, the host context, the permission
// helpers, the screen API helpers and the checks of the action claims.
import { BUSINESS_ROLES, permissionsFor } from '@mscd/shared';
import type { BusinessRole } from '@mscd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { collectActions } from '../../src/screens/actions';
import { NO_CLIENT, call, fieldErrors, newIdempotencyKey } from '../../src/screens/api';
import {
  GROUP_LABELS, HostScreen, SAMPLE_PERSONA_ROLES, apiCan, apiOrgCan, baseRole, canOpenHost, createHostContext, detailNode, firstAdminScreen, firstPlatformScreen,
  hostExtraActions, hostNav, hostVals, sampleCan, sampleGrants, slotNode,
} from '../../src/screens/host';
import type { HostApp, NavGroup } from '../../src/screens/host';
import { HOST_SCREENS } from '../../src/screens/registry';
import { holdsInFull as controlsInFull, mayActOn as controlsMayActOn } from '../../src/screens/controls-edit/common';
import { holdsInFull as docsInFull, mayActOn as docsMayActOn } from '../../src/screens/docs-edit/model';
import { prefetchVisible } from '../../src/screens/registers/actions';
import { canAdd, holdsInFull as registersInFull } from '../../src/screens/registers/model';
import { createSampleAdapter, resetSampleRegisters } from '../../src/screens/registers/sample';
import { managesItems, mayFinishItem, mayReassignItem } from '../../src/screens/timeline-edit/model';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { ADMIN_ROLE_LABELS, BUSINESS_ROLE_LABELS, PLATFORM_ROLE_LABELS, UI_ROLE_LABEL, heldRoleLabel, primaryBusinessRole } from '../../src/screens/roles';
import { PERSONAS } from '../../src/routing/address';
import type { ControllerData, UiRole } from '../../src/data/types';
import type { HostContext, ScreenDef } from '../../src/screens/types';
import { ApiClient } from '../../src/data/api/ApiClient';
import { fakeFetch, json, problem } from '../auth/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/** A host context of a mode and session for the visibility rules. */
function ctxOf(over: Partial<HostContext> & { perms?: { org: string[]; ms: Record<string, string[]> } } = {}): HostContext {
  const lang = over.lang ?? 'en';
  const perms = over.perms;
  const base = {
    lang,
    li: (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? '')),
    fill: (t: unknown) => String(t),
    theme: 'light',
    D: null,
    msObj: { id: 'isms' },
    org: { id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms'], deploy: 'saas', sites: 2 },
    me: null,
    person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
    role: 'manager',
    mode: 'sample',
    client: null,
    ds: null,
    screen: 'portfolio',
    params: {},
    can: (ms: string, perm: string | string[]) => (perms ? apiCan(perms, ms, perm) : sampleCan('manager', perm)),
    orgCan: (perm: string | string[]) => (perms ? apiOrgCan(perms, perm) : sampleCan('manager', perm)),
    platformCan: (perm: string | string[]) => (perms ? apiOrgCan(perms, perm) : false),
    toast: vi.fn(),
    go: vi.fn(),
    track: <T,>(p: Promise<T>) => p,
    reload: async () => undefined,
    command: vi.fn(),
    openPicker: async () => null,
    layer: () => null,
  } as unknown as HostContext;
  return { ...base, ...over } as HostContext;
}

const NAV: NavGroup[] = [
  { id: 'top', label: null, items: [{ id: 'portfolio', label: 'Portfolio Overview' }] },
  { id: 'impl', label: 'Implementation', items: [{ id: 'm1overview', label: 'Overview' }, { id: 'controls', label: 'Controls' }] },
  { id: 'admin', label: 'Administration', items: [{ id: 'fw', label: 'Framework library' }, { id: 'storage', label: 'Storage repositories' }] },
];

describe('visibility of host screens', () => {
  it('sample builds follow the personas of the screen (C.2)', () => {
    const ctx = ctxOf();
    expect(canOpenHost('license', ctx, 'manager')).toBe(true);
    expect(canOpenHost('license', ctx, 'top')).toBe(true);
    expect(canOpenHost('license', ctx, 'owner')).toBe(false);
    expect(canOpenHost('license', ctx, null)).toBe(false);
    expect(canOpenHost('nothing', ctx, 'manager')).toBe(false);
  });

  it('API mode follows the permission in the screen scope', () => {
    const ta = ctxOf({ mode: 'api', perms: { org: ['license.read', 'license.manage'], ms: {} }, msObj: null });
    expect(canOpenHost('license', ta, null)).toBe(true);
    const member = ctxOf({ mode: 'api', perms: { org: [], ms: { isms: ['ms.read', 'license.read'] } } });
    expect(canOpenHost('license', member, 'manager')).toBe(false);
  });

  it('the sidebar inserts host screens into their group by order and drops empty groups', () => {
    const nav = hostNav(NAV, ctxOf(), 'manager');
    const admin = nav.find((g) => g.id === 'admin')!;
    expect(admin.items.map((i) => i.id)).toEqual(['getting-started', 'fw', 'storage', 'organization', 'license', 'systems', 'routing', 'users', 'approvals', 'privacy-requests', 'access-reviews', 'identity-providers', 'org-export']);
    expect(admin.items[4]).toMatchObject({ host: true, label: 'Licence', order: 30 });
    expect(nav.map((g) => g.id)).toEqual(['top', 'impl', 'audit', 'tasks', 'admin', 'ops']);
    // A persona without the Administration group gets it when a host screen of the group is visible.
    const top = hostNav([{ id: 'top', label: null, items: [{ id: 'portfolio', label: 'P' }] }], ctxOf({ lang: 'id' }), 'top');
    // Required documented information (M2-12), the audit screens (M2-14) and Policies to confirm (M3-05) also open for
    // Top Management.
    expect(top.map((g) => [g.id, g.label])).toEqual([['top', null], ['impl', 'Implementasi'], ['audit', 'Audit'], ['tasks', null], ['admin', 'Administrasi']]);
    // With no built-in entries, a Domain Owner gets Required documented information (M2-12), Registers (M2-13),
    // Findings and actions (M2-14) and Policies to confirm (M3-05) in the My Tasks group.
    expect(hostNav([], ctxOf(), 'owner').map((g) => [g.id, g.items.map((i) => i.id)])).toEqual([['impl', ['documented-info', 'registers']], ['audit', ['findings']], ['tasks', ['my-confirmations']]]);
    expect(GROUP_LABELS.ops).toEqual(['Operations', 'Operasi']);
  });

  it('the personas of Milestone 3 E see the host screens their F.6 permissions open, within the screens of their base persona', () => {
    const sidebar = (role: UiRole) => hostNav([], ctxOf({ role }), role).map((g) => [g.id, g.items.map((i) => i.id)]);
    // The Programme Owner: verify and approve rights, the person lists, retention approval and the access review of a
    // system, without the administration screens (no organisation permission in F.6).
    expect(sidebar('sponsor')).toEqual([
      ['impl', ['acknowledgements', 'documented-info', 'registers', 'retention']],
      ['audit', ['internal-audit', 'findings', 'management-review', 'auditor-access', 'access-review', 'handover']],
      ['tasks', ['my-confirmations']],
    ]);
    // The Risk Owner and the Compliance Investigator see what a Domain Owner sees.
    const owner = sidebar('owner');
    expect(sidebar('riskowner')).toEqual(owner);
    expect(sidebar('investigator')).toEqual(owner);
    for (const role of ['sponsor', 'riskowner', 'investigator'] as const) {
      expect(canOpenHost('users', ctxOf({ role }), role), role).toBe(false);
      expect(canOpenHost('account', ctxOf({ role }), role), role).toBe(true);
    }
    expect(canOpenHost('retention', ctxOf({ role: 'sponsor' }), 'sponsor')).toBe(true);
    expect(canOpenHost('privacy-checks', ctxOf({ role: 'sponsor' }), 'sponsor')).toBe(false);
  });

  it('every host screen lists only sample personas, and a new persona only where its base persona is listed', () => {
    for (const def of HOST_SCREENS) {
      for (const role of def.roles) expect(PERSONAS as readonly string[], `${def.id} ${role}`).toContain(role);
      for (const role of def.roles) expect(def.roles, `${def.id} ${role}`).toContain(baseRole(role));
    }
  });

  it('administration and platform landings pick the first screen the session may open (C.3)', () => {
    expect(firstAdminScreen(ctxOf(), 'manager')).toBe('getting-started');
    expect(firstAdminScreen(ctxOf({ mode: 'api', perms: { org: [], ms: {} } }), null)).toBeNull();
    expect(firstPlatformScreen(ctxOf({ mode: 'api', perms: { org: ['ops.read'], ms: {} } }))).toBe(HOST_SCREENS.find((d) => d.scope === 'platform')?.id ?? null);
  });
});

describe('header values of an open host screen', () => {
  it('title, breadcrumb, page actions and Tera help come from the definition', () => {
    const ctx = ctxOf({ lang: 'id' });
    const v = hostVals('license', ctx)!;
    expect(v.title).toBe('Lisensi');
    expect([v.crumb1, v.crumb2]).toEqual(['Administrasi', 'Lisensi']);
    expect(v.pageActions.map((a) => a.label)).toEqual(['Pasang lisensi']);
    expect(v.tera.what).toMatch(/Lisensi organisasi Anda/);
    expect(v.tera.how).toHaveLength(3);
    v.pageActions[0].go();
    expect(ctx.go).toHaveBeenCalledWith('license', { params: { install: expect.any(Number) } });
    expect(hostVals('controls', ctx)).toBeNull();
  });

  it('a session without license.manage gets no Install licence (multi tenancy, D.1)', () => {
    const v = hostVals('license', ctxOf({ mode: 'api', perms: { org: ['license.read'], ms: {} } }))!;
    expect(v.pageActions).toEqual([]);
  });

  it('the body renders the screen inside its context and an error boundary', () => {
    const def: ScreenDef = {
      id: 'example', path: '/x/example', group: 'admin', order: 1, label: ['Example', 'Contoh'], icon: 'M1 1', scope: 'org', roles: ['manager'], perm: 'x',
      Component: ({ ctx }) => <p>{ctx.li(['Hello', 'Halo'])}</p>,
    };
    const html = renderToStaticMarkup(<HostScreen def={def} ctx={ctxOf({ lang: 'id' })} />);
    expect(html).toContain('data-screen="example"');
    expect(html).toContain('Halo');
  });

  it('extensions render nothing when no package adds one; the top bar slot needs a session (M2-16)', () => {
    // Packages extend `req`, `ev` and `activity` (M2-11, M2-14); no package extends `item`.
    expect(detailNode('item', ctxOf(), { ms: 'isms', recordKey: 'isms:x:R-031', record: {}, close: () => undefined })).toBeNull();
    // M2-16 puts the notification bell and "My account" in the top bar; in API mode they need a signed-in person.
    expect(slotNode('topbar', ctxOf())).not.toBeNull();
    expect(slotNode('topbar', ctxOf({ mode: 'api', me: null }))).toBeNull();
    expect(hostExtraActions('fw', ctxOf())).toEqual([]);
  });
});

describe('action claims and extensions of packages', () => {
  const Ext = () => null;
  it('collects claims, extra page actions, detail extensions and slot items in order', () => {
    const handler = vi.fn();
    const out = collectActions({
      './docs-edit/actions.ts': {
        claims: { 'docs.new': handler },
        detailExtensions: [{ id: 'b', kind: 'doc', order: 20, Component: Ext }, { id: 'a', kind: 'doc', order: 10, Component: Ext }],
        extraPageActions: [{ screen: 'fw', id: 'fw.transition', label: ['Edition transition', 'Transisi edisi'], icon: 'M1 1', run: () => undefined }],
        topbarItems: [{ id: 'bell', order: 10, Component: Ext }],
      },
    });
    expect(out.problems).toEqual([]);
    expect(out.claims.get('docs.new')).toBe(handler);
    expect(out.detailExtensions.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out.extraPageActions.map((a) => a.id)).toEqual(['fw.transition']);
    expect(out.topbarItems.map((i) => i.id)).toEqual(['bell']);
  });

  it('refuses unknown ids, a second claim of one id, unknown screens and kinds, and repeated ids', () => {
    const out = collectActions({
      './a/actions.ts': { claims: { 'docs.new': () => undefined, 'nothing.here': () => undefined }, layerItems: [{ id: 'x', order: 1, Component: Ext }] },
      './b/actions.ts': {
        claims: { 'docs.new': () => undefined },
        extraPageActions: [{ screen: 'nowhere' as never, id: 'p', label: ['a', 'b'], icon: 'M', run: () => undefined }],
        detailExtensions: [{ id: 'e', kind: 'risk' as never, order: 1, Component: Ext }],
        topbarItems: [{ id: 'x', order: 1, Component: Ext }],
      },
    });
    const text = out.problems.join('\n');
    expect(text).toMatch(/\.\/a\/actions\.ts: unknown action id nothing\.here/);
    expect(text).toMatch(/\.\/b\/actions\.ts: docs\.new is already claimed by \.\/a\/actions\.ts/);
    expect(text).toMatch(/p adds to unknown screen nowhere/);
    expect(text).toMatch(/e has unknown kind risk/);
    expect(text).toMatch(/slot item id x is used twice/);
  });
});

describe('role labels (M2-01, D2-06)', () => {
  it('one distinct label per business role and per administration role, in both languages', () => {
    const labels = [...Object.values(BUSINESS_ROLE_LABELS), ...Object.values(ADMIN_ROLE_LABELS), ...Object.values(PLATFORM_ROLE_LABELS)];
    expect(Object.keys(BUSINESS_ROLE_LABELS)).toHaveLength(8);
    expect(new Set(labels.map((l) => l[0])).size).toBe(labels.length);
    expect(new Set(labels.map((l) => l[1])).size).toBe(labels.length);
    for (const l of labels) expect(l.join(' ')).not.toMatch(/[\u2014\u00b7]/);
  });

  it('the held role wins in the order of F.7, then administration and platform roles', () => {
    expect(primaryBusinessRole(['domain_owner', 'programme_owner'])).toBe('programme_owner');
    expect(heldRoleLabel(['programme_owner'])).toEqual(['Programme Owner', 'Pemilik Program']);
    expect(heldRoleLabel(['external_auditor'])).toEqual(['External Auditor', 'Auditor Eksternal']);
    expect(heldRoleLabel([], ['storage_admin', 'tenant_admin'])).toEqual(['Tenant Admin', 'Admin Tenant']);
    expect(heldRoleLabel(null, [], ['platform_operator'])).toEqual(['Platform Operator', 'Operator Platform']);
    expect(heldRoleLabel([], [], [])).toBeNull();
  });
});

describe('permissions', () => {
  it('sample personas: the manager holds every permission, the others their own', () => {
    expect(sampleCan('manager', 'license.manage')).toBe(true);
    expect(sampleCan('top', 'license.read')).toBe(true);
    expect(sampleCan('top', 'license.manage')).toBe(false);
    expect(sampleCan('owner', ['x', 'ms.read'])).toBe(true);
    expect(sampleCan(null, 'ms.read')).toBe(false);
    expect(sampleCan('sponsor', 'retention.approve')).toBe(true);
    expect(sampleCan('sponsor', 'retention.manage')).toBe(false);
    expect(sampleCan('riskowner', 'risk.manage')).toBe(true);
    expect(sampleCan('investigator', 'evidence.file.submit')).toBe(false);
  });

  it('sample personas other than the manager hold the F.6 permissions of their business role (MILESTONE-3 E)', () => {
    expect(sampleGrants('manager')).toBe('*');
    for (const [persona, role] of Object.entries(SAMPLE_PERSONA_ROLES) as [Exclude<UiRole, 'manager'>, BusinessRole][]) {
      expect(BUSINESS_ROLES, persona).toContain(role);
      const ctx = { tenancy: 'single' as const, msRoles: [role], anyMsRoles: [role], orgRoles: [], platformRoles: [] };
      expect(sampleGrants(persona), persona).toEqual([...permissionsFor('ms', ctx), ...permissionsFor('org', ctx)]);
      // The matrix gives business roles the same permissions in both tenancy modes.
      expect(permissionsFor('ms', { ...ctx, tenancy: 'multi' }), persona).toEqual(permissionsFor('ms', ctx));
    }
    expect(Object.keys(SAMPLE_PERSONA_ROLES).sort()).toEqual(PERSONAS.filter((p) => p !== 'manager').sort());
  });

  it('a persona of Milestone 3 is shown as its base persona, and each persona has its label', () => {
    expect(PERSONAS.map((p) => [p, baseRole(p)])).toEqual([
      ['manager', 'manager'], ['owner', 'owner'], ['auditor', 'auditor'], ['top', 'top'], ['sponsor', 'manager'], ['riskowner', 'owner'], ['investigator', 'owner'],
    ]);
    expect(baseRole(null)).toBeNull();
    expect(UI_ROLE_LABEL.sponsor).toEqual(['Programme Owner', 'Pemilik Program']);
    expect(UI_ROLE_LABEL.riskowner).toEqual(['Risk Owner', 'Pemilik Risiko']);
    expect(UI_ROLE_LABEL.investigator).toEqual(['Compliance Investigator', 'Investigator Kepatuhan']);
  });

  it('API: per system, organisation and platform permission lists, any of a list', () => {
    const p = { org: ['license.read'], ms: { isms: ['record.assign'] } } as AnyRecord as { org: never[]; ms: Record<string, never[]> };
    expect(apiCan(p, 'isms', 'record.assign')).toBe(true);
    expect(apiCan(p, 'qms', 'record.assign')).toBe(false);
    expect(apiCan(p, null, 'record.assign')).toBe(false);
    expect(apiOrgCan(p, ['license.manage', 'license.read'])).toBe(true);
    expect(apiOrgCan(null, 'license.read')).toBe(false);
  });
});

describe('the host context', () => {
  function app(over: AnyRecord = {}): HostApp {
    return {
      L: 'id', api: true, D: { me: { org: null, permissions: { org: ['ops.read'], ms: {} } }, permissions: { org: ['ops.read'], ms: {} } }, ds: { client: { marker: 1 } },
      me: 'ops', MSL: [], msObj: undefined, org: undefined, state: { theme: 'dark', role: 'manager', screen: 'ops', params: { a: 1 } }, props: {},
      personOf: () => ['Platform Operator', '-'], toast: vi.fn(), go: vi.fn(), track: (p) => p, reloadSystems: vi.fn(async () => undefined), command: vi.fn(),
      pickFileFor: vi.fn(async () => null), layerElement: () => null,
      ...over,
    } as unknown as HostApp;
  }

  it('has no organisation, system or role for a platform operator without a membership', () => {
    const a = app();
    const ctx = createHostContext(a);
    expect([ctx.mode, ctx.lang, ctx.theme, ctx.org, ctx.msObj, ctx.role]).toEqual(['api', 'id', 'dark', null, null, null]);
    expect(ctx.client).toEqual({ marker: 1 });
    expect(ctx.platformCan('ops.read')).toBe(true);
    expect(ctx.orgCan('license.read')).toBe(false);
    expect(ctx.params).toEqual({ a: 1 });
    expect(ctx.person).toEqual({ handle: 'ops', name: 'Platform Operator', jobTitle: '-' });
    expect(ctx.li(['Yes', 'Ya'])).toBe('Ya');
    expect(ctx.fill(['{n} days', '{n} hari'], { n: 3 })).toBe('3 hari');
    ctx.go('ops', { params: { x: 1 } });
    expect(a.go).toHaveBeenCalledWith('ops', { params: { x: 1 } });
    void ctx.reload();
    expect(a.reloadSystems).toHaveBeenCalledWith([]);
  });

  it('sample mode has no client and checks the persona', () => {
    const ctx = createHostContext(app({ api: false, D: { orgs: [] }, MSL: [{ id: 'isms' }], msObj: { id: 'isms' }, org: { id: 'ndt' }, state: { role: 'top', screen: 'license' } }));
    expect(ctx.mode).toBe('sample');
    expect(ctx.client).toBeNull();
    expect(ctx.me).toBeNull();
    expect(ctx.role).toBe('top');
    expect(ctx.orgCan('license.read')).toBe(true);
    expect(ctx.can('isms', 'license.manage')).toBe(false);
  });
});

describe('sample checks of host screens use the base persona (MILESTONE-3 E)', () => {
  /** The host context of the sample build for a persona and the person it stands for, as the controller builds it. */
  function sampleCtx(role: UiRole, handle: string, screen = 'portfolio'): HostContext {
    return createHostContext({
      L: 'en', api: false, D: { orgs: [] }, ds: null, me: handle, MSL: [{ id: 'isms' }], msObj: { id: 'isms' }, org: { id: 'ndt' },
      state: { role, screen }, props: {}, personOf: (h: string) => [h, '-'], toast: vi.fn(), go: vi.fn(), track: (p: Promise<unknown>) => p,
      reloadSystems: vi.fn(async () => undefined), command: vi.fn(), pickFileFor: vi.fn(async () => null), layerElement: () => null,
    } as unknown as HostApp);
  }

  it('the Programme Owner approves documents and assigns reviews in full, as the manager persona does', () => {
    const wulan = sampleCtx('sponsor', 'wulan', 'docs');
    expect(wulan.role).toBe('sponsor');
    for (const perm of ['document.approve', 'record.assign'] as const) {
      expect(docsInFull(wulan, 'isms', perm), perm).toBe(true);
      expect(docsMayActOn(wulan, 'isms', perm, 'bagus'), perm).toBe(true);
      expect(docsInFull(sampleCtx('manager', 'rina'), 'isms', perm), perm).toBe(true);
    }
    // Grants she does not hold (F.6) stay closed.
    expect(docsInFull(wulan, 'isms', 'document.version.create')).toBe(false);
    expect(docsInFull(wulan, 'isms', 'document.manage')).toBe(false);
    // The Risk Owner and the Compliance Investigator act as a Domain Owner: own records only.
    for (const role of ['owner', 'riskowner', 'investigator'] as const) expect(docsInFull(sampleCtx(role, 'ratna'), 'isms', 'record.assign'), role).toBe(false);
  });

  it('the Programme Owner verifies and rejects entries of the controls (applicability.verify, activity.verify)', () => {
    const wulan = sampleCtx('sponsor', 'wulan', 'controls');
    for (const perm of ['applicability.verify', 'activity.verify'] as const) {
      expect(controlsInFull(wulan, 'isms', perm), perm).toBe(true);
      expect(controlsMayActOn(wulan, 'isms', perm, 'bagus'), perm).toBe(true);
    }
    expect(controlsInFull(wulan, 'isms', 'applicability.manage')).toBe(false);
    expect(controlsInFull(sampleCtx('auditor', 'maya'), 'isms', 'applicability.verify')).toBe(false);
    expect(controlsInFull(sampleCtx('riskowner', 'ratna'), 'isms', 'activity.transition')).toBe(false);
  });

  it('registers and the timeline give each persona the grants of its base persona, within its own permissions', () => {
    // The Risk Owner holds `risk.manage` for the assessment of own risks only (F.6): no new risk, as for a Domain Owner.
    expect(registersInFull(sampleCtx('riskowner', 'ratna'), 'isms', 'risk.manage')).toBe(false);
    expect(canAdd(sampleCtx('riskowner', 'ratna'), 'isms', 'risks')).toBe(false);
    expect(canAdd(sampleCtx('manager', 'rina'), 'isms', 'risks')).toBe(true);
    expect(registersInFull(sampleCtx('sponsor', 'wulan'), 'isms', 'register.manage')).toBe(false);
    // The Programme Owner is shown as the manager, but holds neither `prep_task.update` nor `cycle_item.update`.
    const item = { kind: 'prep' as const, ms: 'isms', owner: 'bagus' };
    expect(managesItems(sampleCtx('sponsor', 'wulan'), 'isms')).toBe(true);
    expect(mayReassignItem(sampleCtx('sponsor', 'wulan'), item)).toBe(false);
    expect(mayFinishItem(sampleCtx('sponsor', 'wulan'), item)).toBe(false);
    expect(mayReassignItem(sampleCtx('manager', 'rina'), item)).toBe(true);
    expect(mayFinishItem(sampleCtx('owner', 'bagus'), item)).toBe(true);
  });

  it('register rows: the Risk Owner and the Compliance Investigator read own rows, the Programme Owner every row', async () => {
    const D = { ...makeDates(SAMPLE.TODAY_S), ...(await createSampleDataSource().load()), TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
    const rows = async (role: UiRole, me: string, kind: 'risks' | 'competence') => {
      resetSampleRegisters();
      const adapter = createSampleAdapter({ getD: () => D, me: () => me, role: () => role, ds: () => null });
      const res = await adapter.list('isms', kind, { page: 1, pageSize: 50 });
      if (!res.ok) throw new Error('list failed');
      return res.data.items.map((r) => (kind === 'risks' ? r.code : (r as { personHandle?: string }).personHandle));
    };
    const allRisks = await rows('manager', 'rina', 'risks');
    expect(allRisks).toHaveLength(6);
    // The same person under each own-scoped persona sees exactly the rows of a Domain Owner: R-014 of Bagus Prasetyo.
    for (const role of ['owner', 'riskowner', 'investigator'] as const) {
      expect(await rows(role, 'bagus', 'risks'), role).toEqual(['R-014']);
      expect(await rows(role, 'bagus', 'competence'), role).toEqual(['bagus']);
    }
    // In the sample no ISMS risk belongs to Ratna Kusumawati or Gilang Saputra.
    expect(await rows('riskowner', 'ratna', 'risks')).toEqual([]);
    expect(await rows('investigator', 'gilang', 'risks')).toEqual([]);
    // The Programme Owner reads every row, competence of other people included (full read scope, H.5).
    expect(await rows('sponsor', 'wulan', 'risks')).toEqual(allRisks);
    expect(await rows('sponsor', 'wulan', 'competence')).toEqual(await rows('manager', 'rina', 'competence'));
    resetSampleRegisters();
  });

  it('the Registers prefetch runs for every persona the screen lists', () => {
    const def = HOST_SCREENS.find((d) => d.id === 'registers')!;
    for (const role of PERSONAS) expect(prefetchVisible(sampleCtx(role, 'rina')), role).toBe(def.roles.includes(role));
    expect(def.roles).toEqual(expect.arrayContaining(['sponsor', 'riskowner', 'investigator']));
    expect(prefetchVisible(sampleCtx('manager', 'rina', 'registers'))).toBe(false);
  });
});

describe('screen API helpers', () => {
  it('call sends method, path, body, If-Match, Idempotency-Key and X-CSRF-Token through the client', async () => {
    const f = fakeFetch({ 'PATCH /api/v1/ms/isms/things/7': json({ ok: true }) });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const res = await call(client, ['PATCH', '/api/v1/ms/:ms/things/:id'], { params: { ms: 'isms', id: 7 }, body: { a: 1 }, ifMatch: 'W/"3"', idempotencyKey: 'k-1' });
    expect(res.ok).toBe(true);
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/ms/isms/things/7', body: { a: 1 } });
    expect(f.calls[0].headers).toMatchObject({ 'if-match': 'W/"3"', 'idempotency-key': 'k-1', 'x-csrf-token': 'csrf-token-0123456789abcdef' });
  });

  it('keeps the field errors of a refused write and maps them by field', async () => {
    const f = fakeFetch({ 'POST /api/v1/things': problem(400, 'validation', { errors: [{ path: 'body.name', message: 'Required' }, { path: 'body.name', message: 'Too short' }, { path: 'body', message: 'Bad document' }] }) });
    const res = await call(new ApiClient({ fetch: f.fetch }), ['POST', '/api/v1/things'], { body: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const fields = fieldErrors(res.error);
    expect(fields.name).toBe('Required; Too short');
    expect(fields['body.name']).toBe('Required; Too short');
    expect(fields['']).toBe('Bad document');
    expect(fieldErrors(null)).toEqual({});
  });

  it('answers status 0 without a client (sample mode) and makes unique idempotency keys', async () => {
    const res = await call(null, ['GET', '/api/v1/license']);
    expect(res).toEqual({ ok: false, status: 0, error: { status: 0, message: NO_CLIENT } });
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
