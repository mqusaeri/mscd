// Management systems (MILESTONE-2 M2-09): routes against the shared table, the form helpers (ManagementSystemCreate
// and ManagementSystemPatch of D.2), the primary managers from the members list, the API adapters over a fake fetch,
// the sample adapter, the edition transition rows and drawer, the Framework library page action, and the views in
// both languages and themes.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { ManagementSystemView } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/systems/index';
import { ROUTES, ROUTE_IDS } from '../../src/screens/systems/routes';
import { createApiAdapter, createTransitionAdapter, fromSystemView } from '../../src/screens/systems/api';
import { SAMPLE_PACKS, createSampleAdapter, resetSampleSystems, sampleSystemsData } from '../../src/screens/systems/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/systems/adapter';
import {
  createBody, emptySystem, formOfSystem, installablePacks, newerEdition, patchBody, primaryManagers, slugOfCode, systemErrors, transitionRows,
} from '../../src/screens/systems/model';
import type { SystemsAdapter, SystemsData, TransitionAdapter } from '../../src/screens/systems/model';
import { ColourField, NoSystems, SystemDrawer, SystemsTable, editionText } from '../../src/screens/systems/Screen';
import TransitionDrawer, { TransitionList } from '../../src/screens/systems/Transition';
import { extraPageActions, layerItems, mayTransition } from '../../src/screens/systems/actions';
import { requestTransition, transitionRequest } from '../../src/screens/systems/store';
import { PALETTE, TEXT } from '../../src/screens/systems/text';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData } from '../../src/data/types';
import { MS, PEOPLE, REPOS, TODAY_S } from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const D = { ...makeDates(TODAY_S), MS, PEOPLE, REPOS, TODAY_S } as unknown as ControllerData;

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: null, org: { id: 'ndt' }, me: null, person: { handle: 'rina', name: 'Rina', jobTitle: '-' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'systems', params: {}, can: () => true, orgCan: () => true, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

const ISMS_VIEW: ManagementSystemView = {
  id: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c', slug: 'isms', code: 'ISMS', name: 'Information security management system', frameworkCode: 'ISO27001',
  frameworkName: 'ISO/IEC 27001', edition: '2022', packId: 'ISO27001-2022', packVersion: '1.3.0', transitionTargetEdition: null, applicabilityTarget: 'catalogue_item',
  status: 'certified', scopeStatement: 'Data centre operations', certificationBody: 'PT Sertifikasi Nusantara', color: '#e8731a', defaultRepository: 'sp', position: 0,
  createdAt: '2026-02-02T03:00:00Z',
};
const USERS = [
  { displayName: 'Rina Kusuma', roles: [{ ms: 'isms', role: 'ms_manager', isPrimary: true, approvalStatus: 'active' }, { ms: 'qms', role: 'ms_manager', isPrimary: false, approvalStatus: 'active' }] },
  { displayName: 'Sari Wulandari', roles: [{ ms: 'qms', role: 'ms_manager', isPrimary: true, approvalStatus: 'pending_approval' }] },
  { displayName: 'Bagus Prasetyo', roles: [{ ms: 'bcms', role: 'domain_owner', isPrimary: false, approvalStatus: 'active' }] },
];

afterEach(() => {
  resetSampleSystems();
  requestTransition(null);
});

describe('management system routes', () => {
  it('match the shared route table and its permissions', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.msCreate)).toMatchObject({ permission: 'ms.admin', allOf: ['pack.activate'] });
    expect(routeById(ROUTE_IDS.msUpdate).permission).toBe('ms.admin');
    expect(routeById(ROUTE_IDS.msTransition).permission).toBe('ms.transition');
  });
});

describe('the system form', () => {
  const data: SystemsData = sampleSystemsData(D);

  it('starts with an unused palette colour, the vault and the first installed pack', () => {
    const form = emptySystem(data);
    expect(form).toMatchObject({ packId: 'ISO22301-2019', defaultRepository: 'vault', color: PALETTE[0].value });
    expect(installablePacks([...SAMPLE_PACKS, { ...SAMPLE_PACKS[0], packId: 'ISO27001-2013', status: 'superseded' }]).map((p) => p.packId)).toEqual(['ISO22301-2019', 'ISO27001-2022', 'ISO37001-2025', 'ISO9001-2015', 'ISO9001-2026']);
    expect(slugOfCode('ISMS 2')).toBe('isms-2');
    expect(slugOfCode('27K')).toBe('k');
  });

  it('checks code, short id, name, pack, scope, body, colour and repository', () => {
    const form = { ...emptySystem(data), code: 'ISMS2', slug: 'isms2', name: 'Second ISMS', packId: 'ISO27001-2022', scopeStatement: 'Head office' };
    expect(systemErrors(form, 'create')).toEqual({});
    expect(systemErrors({ ...form, code: '', slug: 'ISMS 2', name: '', packId: '', scopeStatement: ' ', color: 'red', defaultRepository: '', certificationBody: 'x'.repeat(151) }, 'create')).toEqual({
      code: TEXT.required, slug: TEXT.badSlug, name: TEXT.required, packId: TEXT.required, scopeStatement: TEXT.required, color: TEXT.required, defaultRepository: TEXT.required, certificationBody: TEXT.tooLong,
    });
    expect(systemErrors({ ...form, code: '', slug: '' }, 'edit')).toEqual({});
  });

  it('builds ManagementSystemCreate with the edition of the chosen pack, and a patch of the changed fields', () => {
    const form = { ...emptySystem(data), code: ' ISMS2 ', slug: 'isms2', name: 'Second ISMS', packId: 'ISO27001-2022', scopeStatement: 'Head office', certificationBody: '' };
    expect(createBody(form, SAMPLE_PACKS as never)).toEqual({ slug: 'isms2', code: 'ISMS2', name: 'Second ISMS', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Head office', defaultRepository: 'vault', color: PALETTE[0].value });
    const system = fromSystemView(ISMS_VIEW);
    const same = formOfSystem(system);
    expect(patchBody(same, system)).toBeNull();
    expect(patchBody({ ...same, certificationBody: '', color: '#2E7FB8', defaultRepository: 'vault', scopeStatement: 'Data centre and offices' }, system)).toEqual({ certificationBody: null, color: '#2E7FB8', defaultRepository: 'vault', scopeStatement: 'Data centre and offices' });
    expect(patchBody({ ...same, color: '#E8731A' }, system)).toBeNull();
  });

  it('takes the primary MS Manager of each system from the active grants', () => {
    expect([...primaryManagers(USERS)]).toEqual([['isms', 'Rina Kusuma']]);
  });
});

describe('management system API adapters', () => {
  it('loads systems, packs, repositories and the members page by page', async () => {
    const page = (n: number, items: unknown[]) => json({ items, page: n, pageSize: 200, total: 201 });
    const many = Array.from({ length: 200 }, (_, i) => ({ displayName: `Staff ${i}`, roles: [] }));
    const f = fakeFetch({
      'GET /api/v1/admin/management-systems': json([ISMS_VIEW, { ...ISMS_VIEW, id: '6f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c', slug: 'qms', code: 'QMS' }]),
      'GET /api/v1/admin/packs': json([{ packId: 'ISO27001-2022', version: '1.3.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false, installedAt: null, checksum: 'ab'.repeat(32), signatureKeyId: 'k' }]),
      'GET /api/v1/admin/storage/repositories': json([{ id: 'sp', name: 'SharePoint Online' }]),
      'GET /api/v1/admin/users': [page(1, many), page(2, [USERS[0]])],
    });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), { users: true }).load();
    if (!res.ok) throw new Error('load failed');
    expect(res.data.systems.map((s) => [s.code, s.primaryManager])).toEqual([['ISMS', 'Rina Kusuma'], ['QMS', null]]);
    expect(res.data.packs).toEqual([{ packId: 'ISO27001-2022', version: '1.3.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false }]);
    expect(res.data.repos).toEqual([{ slug: 'sp', name: 'SharePoint Online' }]);
    expect(f.calls.filter((c) => c.path === '/api/v1/admin/users').map((c) => c.url)).toEqual(['/api/v1/admin/users?page=1&pageSize=200', '/api/v1/admin/users?page=2&pageSize=200']);
  });

  it('without user.manage the manager column says it is not shown', async () => {
    const f = fakeFetch({ 'GET /api/v1/admin/management-systems': json([ISMS_VIEW]), 'GET /api/v1/admin/packs': json([]), 'GET /api/v1/admin/storage/repositories': json([]) });
    const res = await createApiAdapter(new ApiClient({ fetch: f.fetch }), { users: false }).load();
    expect(res).toMatchObject({ ok: true, data: { systems: [{ code: 'ISMS' }] } });
    if (res.ok) expect(res.data.systems[0].primaryManager).toBeUndefined();
  });

  it('creates with POST and the Idempotency-Key, changes with PATCH, and keeps the refusal of Start implementation', async () => {
    const refused = problem(409, 'conflict', { messageKey: 'ms.manager_required', messages: { en: 'Assign at least one Management System Manager before the system moves to implementing.', id: 'Tetapkan minimal satu Management System Manager sebelum sistem berpindah ke tahap implementasi.' } });
    const f = fakeFetch({
      'POST /api/v1/admin/management-systems': json({ ...ISMS_VIEW, slug: 'isms2', code: 'ISMS2', status: 'setup' }, 201),
      [`PATCH /api/v1/admin/management-systems/${ISMS_VIEW.id}`]: [refused, json({ ...ISMS_VIEW, status: 'implementing' })],
    });
    const client = new ApiClient({ fetch: f.fetch });
    client.setCsrfToken('csrf-token-0123456789abcdef');
    const adapter = createApiAdapter(client, { users: false });
    const body = { slug: 'isms2', code: 'ISMS2', name: 'Second', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Office', defaultRepository: 'vault', color: '#2e7fb8' };
    expect(await adapter.create(body, 'key-9')).toMatchObject({ ok: true, data: { code: 'ISMS2', status: 'setup', primaryManager: null } });
    expect(f.calls[0]).toMatchObject({ method: 'POST', body });
    expect(f.calls[0].headers['idempotency-key']).toBe('key-9');
    expect(f.calls[0].headers['x-csrf-token']).toBe('csrf-token-0123456789abcdef');
    expect(await adapter.update(ISMS_VIEW.id, { status: 'implementing' })).toMatchObject({ ok: false, error: { status: 409, messageKey: 'ms.manager_required', message: ['Assign at least one Management System Manager before the system moves to implementing.', 'Tetapkan minimal satu Management System Manager sebelum sistem berpindah ke tahap implementasi.'] } });
    expect(await adapter.update(ISMS_VIEW.id, { status: 'implementing' })).toMatchObject({ ok: true, data: { status: 'implementing' } });
    expect(f.calls[2]).toMatchObject({ method: 'PATCH', body: { status: 'implementing' } });
  });

  it('the transition adapter reads the packs and posts the transition with its message', async () => {
    const f = fakeFetch({
      'GET /api/v1/admin/packs': json([]),
      'POST /api/v1/ms/qms/transitions': json({ ok: true, changed: ['qms'], message: ['QMS is transitioning to ISO 9001:2026', 'QMS sedang bertransisi ke ISO 9001:2026'] }),
    });
    const adapter = createTransitionAdapter(new ApiClient({ fetch: f.fetch }));
    expect(await adapter.packs()).toEqual({ ok: true, data: [] });
    expect(await adapter.statuses()).toBeNull();
    const admin = createTransitionAdapter(new ApiClient({ fetch: fakeFetch({ 'GET /api/v1/admin/management-systems': json([ISMS_VIEW, { ...ISMS_VIEW, slug: 'qms', status: 'transitioning' }]) }).fetch }), { statuses: true });
    expect(await admin.statuses()).toEqual({ isms: 'certified', qms: 'transitioning' });
    expect(await adapter.transition('qms', { to: 'transitioning', targetEdition: '2026' })).toEqual({ ok: true, data: { changed: ['qms'] }, message: ['QMS is transitioning to ISO 9001:2026', 'QMS sedang bertransisi ke ISO 9001:2026'] });
    expect(f.calls[1].body).toEqual({ to: 'transitioning', targetEdition: '2026' });
  });
});

describe('management system sample adapter', () => {
  it('lists the sample systems with their state and primary managers', () => {
    const data = sampleSystemsData(D);
    expect(data.systems.map((s) => [s.code, s.status, s.edition, s.transitionTargetEdition, s.primaryManager])).toEqual([
      ['ISMS', 'certified', '2022', null, 'Rina Kusuma'], ['QMS', 'transitioning', '2015', '2026', 'Sari Wulandari'], ['BCMS', 'implementing', '2019', null, 'Tono Hartono'], ['ABMS', 'setup', '2025', null, 'Lina Marlina'],
    ]);
  });

  it('creates a system in setup, refuses Start implementation without a manager, edits and archives', async () => {
    const adapter = createSampleAdapter(() => D);
    const created = await adapter.create({ slug: 'isms2', code: 'ISMS2', name: 'Second', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Office', defaultRepository: 'vault', color: '#2e7fb8' }, 'k');
    expect(created).toMatchObject({ ok: true, data: { status: 'setup', primaryManager: null }, message: ['ISMS2 created with 123 entries', 'ISMS2 dibuat dengan 123 entri'] });
    if (!created.ok) return;
    expect(await adapter.create({ slug: 'isms2', code: 'X', name: 'x', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'x', defaultRepository: 'vault', color: '#2e7fb8' }, 'k')).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await adapter.update(created.data.id, { status: 'implementing' })).toMatchObject({ ok: false, error: { message: ['Assign at least one Management System Manager before the system moves to implementing.', expect.any(String)] } });
    expect(await adapter.update(created.data.id, { color: '#c94f6d' })).toMatchObject({ ok: true, data: { color: '#c94f6d' } });
    expect(await adapter.update(created.data.id, { status: 'archived' })).toMatchObject({ ok: true, data: { status: 'archived' } });
    expect(await adapter.update(created.data.id, { color: '#2e7fb8' })).toMatchObject({ ok: false, error: { status: 409 } });
  });

  it('keeps the systems and the changes of the session per organisation when the organisation switcher changes the snapshot', async () => {
    const source = createSampleDataSource();
    const snapshotOf = async (org: string) => ({ ...makeDates(TODAY_S), ...(await source.load(org)), TODAY_S }) as unknown as ControllerData;
    const [ndt, rmn] = [await snapshotOf('ndt'), await snapshotOf('rmn')];
    let current = ndt;
    const adapter = createSampleAdapter(() => current);
    const codes = async () => {
      const res = await adapter.load();
      return res.ok ? res.data.systems.map((s) => s.code) : null;
    };
    const body = { slug: 'isms2', code: 'ISMS2', name: 'Second', packId: 'ISO27001-2022', edition: '2022', scopeStatement: 'Office', defaultRepository: 'sp', color: '#2e7fb8' };
    expect(await codes()).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS']);
    expect(await adapter.create(body, 'k')).toMatchObject({ ok: true });
    expect(await codes()).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS', 'ISMS2']);
    current = rmn;
    expect(await codes()).toEqual(['ISMS']);
    expect(sampleSystemsData(rmn).repos.map((r) => r.slug)).toEqual(['sp', 'od']);
    // The short id is taken only in the organisation that made it.
    expect(await adapter.create(body, 'k')).toMatchObject({ ok: true });
    expect(await adapter.update('sample-isms', { color: '#c94f6d' })).toMatchObject({ ok: true, data: { color: '#c94f6d' } });
    current = ndt;
    expect(await codes()).toEqual(['ISMS', 'QMS', 'BCMS', 'ABMS', 'ISMS2']);
    expect(sampleSystemsData(ndt).systems.find((s) => s.slug === 'isms')?.color).toBe(ndt.MS[0].color);
    // A new adapter (the screen opened again) finds the session's changes of each organisation.
    const reopened = await createSampleAdapter(() => rmn).load();
    expect(reopened.ok ? reopened.data.systems.map((s) => [s.code, s.color]) : null).toEqual([['ISMS', '#c94f6d'], ['ISMS2', '#2e7fb8']]);
  });

  it('the build chooses the adapter, and a deferred adapter retries a failed module load', async () => {
    expect(await adapterFor(ctxOf('en'), () => D).load()).toMatchObject({ ok: true, data: { sample: true } });
    const load = vi.fn<() => Promise<SystemsAdapter>>().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(createSampleAdapter(() => D));
    const adapter = deferredAdapter(load);
    await expect(adapter.load()).rejects.toThrow('chunk');
    expect(await adapter.load()).toMatchObject({ ok: true });
  });
});

describe('edition transition', () => {
  it('lists the systems with a newer edition installed or in transition, among those the session may transition', () => {
    const packs = [...SAMPLE_PACKS, { packId: 'ISO27001-2030', version: '0.1.0', frameworkCode: 'ISO27001', edition: '2030', status: 'validating' as const, preRelease: true }];
    const rows = transitionRows(MS, packs, () => true);
    expect(rows.map((r) => [r.code, r.edition, r.target, r.newer])).toEqual([['QMS', '2015', '2026', ['2026']]]);
    const older = transitionRows([{ ...MS[3], ed: '2016', code: 'ISO 37001' }], packs, () => true);
    expect(older.map((r) => [r.code, r.newer])).toEqual([['ABMS', ['2025']]]);
    expect(transitionRows(MS, packs, (ms) => ms !== 'qms')).toEqual([]);
    // With the statuses: a certified system whose target is set but not started is offered the start (the demo QMS).
    const known = transitionRows(MS, packs, () => true, { qms: 'certified', isms: 'certified' });
    expect(known.map((r) => [r.code, r.target, r.newer, r.status])).toEqual([['QMS', null, ['2026'], 'certified']]);
    expect(transitionRows(MS, packs, () => true, { qms: 'transitioning' }).map((r) => [r.target, r.status])).toEqual([['2026', 'transitioning']]);
    expect([newerEdition('2026', '2015'), newerEdition('2015', '2026'), newerEdition('b', 'a')]).toEqual([true, false, true]);
  });

  it('the drawer list in both languages, with the note that entries keep the old edition', () => {
    for (const lang of ['en', 'id'] as Lang[]) {
      const ctx = ctxOf(lang);
      const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
      const rows = transitionRows(MS, SAMPLE_PACKS as never, () => true);
      const html = render(<TransitionList ctx={ctx} rows={[...rows, { ...rows[0], ms: 'abms', code: 'ABMS', target: null, newer: ['2025'] }, { ...rows[0], ms: 'bcms', code: 'BCMS', target: null, newer: ['2025'], status: 'implementing' }]} targets={{}} onTarget={() => undefined} onStart={() => undefined} onFinish={() => undefined} busy={null} errors={{ qms: { status: 409, message: ['Record the transition audit', 'Catat audit transisi'] } }} />, ctx, 'dark');
      for (const p of [TEXT.finishTransition, TEXT.finishHint, TEXT.startTransition, TEXT.startHint]) expect(html).toContain(t(p));
      // A system that is not certified gets the start disabled with the reason next to it.
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t(TEXT.startTransition)}</button><span[^>]*class="mx-reason">${t(TEXT.startHint)}`));
      expect(html).toContain(lang === 'id' ? 'Transisi ke 2026 sedang berjalan' : 'Transition to 2026 in progress');
      expect(html).toContain(lang === 'id' ? 'Catat audit transisi' : 'Record the transition audit');
      const empty = render(<TransitionList ctx={ctx} rows={[]} targets={{}} onTarget={() => undefined} onStart={() => undefined} onFinish={() => undefined} busy={null} errors={{}} />, ctx);
      expect(empty).toContain(t(TEXT.transitionNone));
      const fake: TransitionAdapter = { packs: async () => ({ ok: true, data: [] }), statuses: async () => null, transition: async () => ({ ok: true, data: { changed: [] } }) };
      const drawer = render(<TransitionDrawer ctx={ctx} adapter={fake} onClose={() => undefined} />, ctx);
      expect(drawer).toContain(t(TEXT.transitionNote));
      expect(drawer).toMatch(/role="dialog"/);
    }
  });

  it('the Framework library page action shows in API builds for MS Managers and opens the drawer', () => {
    const [action] = extraPageActions!;
    expect(action).toMatchObject({ screen: 'fw', id: 'fw.transition', label: ['Edition transition', 'Transisi edisi'] });
    expect(mayTransition(ctxOf('en'))).toBe(false);
    expect(mayTransition(ctxOf('en', { mode: 'api', can: (ms) => ms === 'qms' }))).toBe(true);
    expect(mayTransition(ctxOf('en', { mode: 'api', can: () => false }))).toBe(false);
    action.run(ctxOf('en'));
    expect(transitionRequest()).toEqual(expect.any(Number));
    expect(layerItems!.map((i) => i.id)).toEqual(['systems-transition']);
  });
});

describe('management system views', () => {
  const data: SystemsData = sampleSystemsData(D);

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the table and the forms in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf(lang);
        const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
        const table = render(<SystemsTable ctx={ctx} data={data} onEdit={() => undefined} onStart={() => undefined} onArchive={() => undefined} />, ctx, theme);
        for (const p of [TEXT.colCode, TEXT.colName, TEXT.colEdition, TEXT.colStatus, TEXT.colManager, TEXT.colRepository, TEXT.edit, TEXT.start, TEXT.archive, TEXT.statusCertified, TEXT.statusTransitioning, TEXT.statusSetup]) expect(table, p[0]).toContain(t(p));
        expect(table).toContain(lang === 'id' ? 'ISO 9001 2015, dalam transisi ke 2026' : 'ISO 9001 2015, in transition to 2026');
        expect(table).toContain('Rina Kusuma');
        const adapter = createSampleAdapter(() => D);
        const add = render(<SystemDrawer ctx={ctx} adapter={adapter} data={{ ...data }} system={null} open onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        for (const p of [TEXT.formNew, TEXT.code, TEXT.slug, TEXT.name, TEXT.pack, TEXT.scope, TEXT.body, TEXT.colour, TEXT.repository, TEXT.installed]) expect(add, p[0]).toContain(t(p));
        expect(add).toContain(lang === 'id' ? 'ISO 22301:2019 (paket 1.1.0)' : 'ISO 22301:2019 (pack 1.1.0)');
        expect(add).toMatch(/role="dialog"/);
        const beta = render(<SystemDrawer ctx={ctx} adapter={adapter} data={{ ...data, packs: [SAMPLE_PACKS[4]] }} system={null} open onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        expect(beta).toContain(t(TEXT.betaNotice));
        expect(beta).toContain(t(TEXT.preRelease));
        const edit = render(<SystemDrawer ctx={ctx} adapter={adapter} data={data} system={data.systems[0]} open onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        expect(edit).toContain(lang === 'id' ? 'Ubah ISMS' : 'Edit ISMS');
        expect(edit).toContain(t(TEXT.currentColour));
        expect(table + add + edit).not.toMatch(/[\u2014\u00b7]/);
      });
    }
  }

  it('archived systems come last without actions; the manager column marks a missing manager', () => {
    const ctx = ctxOf('en');
    const archived = { ...data, systems: [{ ...data.systems[0], status: 'archived' as const }, { ...data.systems[1], primaryManager: null }, { ...data.systems[2], primaryManager: undefined }] };
    const html = render(<SystemsTable ctx={ctx} data={archived} onEdit={() => undefined} onStart={() => undefined} onArchive={() => undefined} />, ctx);
    expect(html.indexOf('QMS')).toBeLessThan(html.indexOf('ISMS'));
    expect(html).toContain(TEXT.noManager[0]);
    expect(html).toContain(TEXT.managerUnknown[0]);
    expect(editionText(ctx, data.systems[0])).toBe('ISO/IEC 27001 2022');
    const colour = render(<ColourField ctx={ctx} value={PALETTE[1].value} onChange={() => undefined} />, ctx);
    for (const p of PALETTE) expect(colour).toContain(p.name[0]);
    expect(colour).not.toContain(TEXT.currentColour[0]);
  });

  it('before the first system the empty state shows the no-systems scene of the illustration library and the form button', () => {
    for (const lang of ['en', 'id'] as Lang[]) {
      const ctx = ctxOf(lang);
      const t = (p: readonly [string, string]) => p[lang === 'id' ? 1 : 0];
      const html = render(<NoSystems ctx={ctx} onNew={() => undefined} />, ctx);
      expect(html).toContain('data-scene="no-systems"');
      // Decorative: the title and text say everything, so screen readers skip the picture.
      expect(html).toMatch(/data-scene="no-systems"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-scene="no-systems"/);
      for (const p of [TEXT.none, TEXT.noneText, TEXT.newSystem]) expect(html, p[0]).toContain(t(p));
    }
  });

  it('every text has both languages, Indonesian that differs (product words excepted), and no em dash or centre dot', () => {
    const same = new Set(['colStatus']);
    for (const [key, pair] of Object.entries(TEXT)) {
      if (!same.has(key)) expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(/[\u2014\u00b7]/);
    }
    for (const p of PALETTE) expect(p.name[1]).not.toBe(p.name[0]);
  });

  it('is in the Administration group with ms.admin and offers New management system with pack.activate', () => {
    expect(screen).toMatchObject({ id: 'systems', path: '/admin/systems', group: 'admin', scope: 'org', perm: 'ms.admin' });
    const ctx = ctxOf('en');
    const actions = screen.pageActions!(ctx);
    expect(actions.map((a) => a.label[0])).toEqual(['New management system']);
    actions[0].run(ctx);
    expect(ctx.go).toHaveBeenCalledWith('systems', { params: { create: expect.any(Number) } });
    expect(screen.pageActions!(ctxOf('en', { orgCan: (p) => p !== 'pack.activate' }))).toEqual([]);
  });
});
