// The controller in API mode (BUILD-PLAN H.5 steps 5, 6, 8, 9, 10, 12, 13, 14) over the API source and a fake fetch,
// and the screen host of Milestone 2 (MILESTONE-2 C.3 to C.5, M2-01) in both modes.
// MscdApp is used as a plain object (no DOM): setState merges at once, and renderVals() builds the view model of
// every screen, which is what AppView renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MscdApp from '../../src/MscdApp.jsx';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { HOST_SCREENS } from '../../src/screens/registry';
import { BUILTIN_SCREEN_IDS } from '../../src/screens/types';
import { BUSINESS_ROLE_LABELS } from '../../src/screens/roles';
import { NOT_COMPUTED } from '../../src/data/api/wire';
import { clauseFixture } from '../fixtures/screens/clauses';
import { json, meOf, readRoutes, refOf, sourceWith, uuidOf, wireOf } from './fixtures';
import type { Routes } from './fixtures';
import { problem } from '../auth/helpers';

// Test data of many shapes (wire snapshots, view models) is read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
// Every screen: the 14 built-in screens and every host screen of the registry (MILESTONE-2 C.7).
const SCREENS = [...BUILTIN_SCREEN_IDS, ...HOST_SCREENS.map((d) => d.id)];

function mount(ds: unknown, props: AnyRecord = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the controller is a JavaScript class
  const app = new (MscdApp as any)({ lang: 'en', theme: 'light', deploy: 'saas', ...props, dataSource: ds }) as AnyRecord;
  app.setState = (u: unknown, cb?: () => void) => {
    const patch = typeof u === 'function' ? (u as (s: AnyRecord, p: AnyRecord) => AnyRecord)(app.state, app.props) : u;
    if (patch) app.state = { ...app.state, ...(patch as AnyRecord) };
    if (cb) cb();
  };
  return app;
}

async function start(routes: Routes, props: AnyRecord = {}) {
  const env = sourceWith(routes);
  const app = mount(env.ds, props);
  app.firstLoad();
  await vi.waitFor(() => expect(app.state.D || app.state.loadError).toBeTruthy());
  env.calls.length = 0;
  return { ...env, app };
}

/** Waits until every queued command of the controller has finished. */
async function settle(app: AnyRecord) {
  await vi.waitFor(() => expect(app.state.busy).toBe(0));
  await (app._q ?? Promise.resolve());
}

function renderAll(app: AnyRecord) {
  for (const lang of ['en', 'id']) {
    for (const screen of SCREENS) {
      app.state = { ...app.state, screen, lang, sel: null };
      expect(() => app.renderVals(), `${screen} ${lang}`).not.toThrow();
    }
  }
  app.state = { ...app.state, lang: 'en' };
}

async function acme() {
  const fx = await wireOf();
  const acmeOrg = { id: uuidOf('org:acme'), slug: 'acme', name: 'PT Acme Industri' };
  const perms = { isms: ['ms.read', 'applicability.verify', 'activity.verify', 'audit.pending.all'], qms: ['ms.read'] };
  const me = meOf({ org: acmeOrg, handle: 'joko', uiRoleByMs: { isms: 'manager', qms: 'owner' }, perms, orgs: [{ id: 'acme', name: 'PT Acme Industri', ms: ['isms', 'qms'], deploy: 'onprem', sites: 1 }] });
  const org = {
    ...fx.org,
    orgs: me.orgs,
    MS: fx.org.MS.filter((m: AnyRecord) => ['isms', 'qms'].includes(m.id)),
    PEOPLE: { ...fx.org.PEOPLE },
    ROLES: { manager: { who: 'joko', label: ['Management System Manager', 'Management System Manager'] }, owner: { who: 'joko', label: ['Domain Owner', 'Pemilik Domain'] } },
    PACKS: {},
    LICENCE: null,
    permissions: { org: [], ms: perms },
  };
  return { fx, me, routes: { ...readRoutes(fx, me), 'GET /api/v1/ui/org': json(org) } as Routes };
}

describe('controller in API mode', () => {
  // The controller logs failed loads and commands; the tests assert what the user sees instead.
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a non-demo user of acme: state from Me, role per system, every screen renders', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    expect(app.api).toBe(true);
    expect(app.state.loadError).toBeNull();
    expect([app.state.org, app.state.ms, app.state.role]).toEqual(['acme', 'isms', 'manager']);
    expect(app.me).toBe('joko');
    expect(app.MSL.map((m: AnyRecord) => m.id)).toEqual(['isms', 'qms']);
    renderAll(app);
    // The UI role follows the system.
    app.state = { ...app.state, screen: 'storage' };
    app.setMs('qms');
    expect(app.state.role).toBe('owner');
    expect(app.state.screen).toBe('mytasks');
    renderAll(app);
    app.go('controls', { ms: 'isms' });
    expect(app.state.role).toBe('manager');
    // Persona menu outside demo mode: the role of this system and Sign out.
    const v = app.renderVals();
    expect(v.roleOptions.map((r: AnyRecord) => r.label)).toEqual(['Management System Manager', '']);
    expect(v.roleOptions[1].name).toBe('Sign out');
    expect(v.me.name).toBe(app.personOf('joko')[0]);
  });

  it('absent licence and pack cards render as -', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    app.state = { ...app.state, screen: 'fw' };
    const fw = app.renderVals().fw;
    expect(fw.to).toBe('-');
    expect(fw.featureChips).toEqual([]);
    expect(fw.lic.map((l: AnyRecord) => l.n)).toEqual(['-', '-', '-']);
    expect(fw.cards.every((c: AnyRecord) => c.pack === '-' && c.installed === '-')).toBe(true);
  });

  it('verify and the people list follow the permissions of the system', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    const d = app.data(app.MSL.find((m: AnyRecord) => m.id === 'isms'));
    const done = d.reqs.find((c: AnyRecord) => c.st === 'complete') ?? { ...d.reqs[0], st: 'complete', by: 'bagus' };
    expect(app.reqDetail(done, d).actions.some((a: AnyRecord) => a.label === app.t('verify'))).toBe(true);
    const dq = app.data(app.MSL.find((m: AnyRecord) => m.id === 'qms'));
    const doneQ = { ...dq.reqs[0], st: 'complete', by: 'sari' };
    expect(app.reqDetail(doneQ, dq).actions.some((a: AnyRecord) => a.label === app.t('verify'))).toBe(false);
    app.state = { ...app.state, ms: 'isms', screen: 'chain' };
    expect(app.renderVals().people).not.toBeNull();
    app.state = { ...app.state, ms: 'qms', role: 'owner', screen: 'chain' };
    expect(app.chainScreen(dq).people).toBeNull();
  });

  it('My Tasks: stored tasks are listed and completed through /tasks; a SoA item opens the gate', async () => {
    const fx = await wireOf();
    const me = meOf();
    // A SoA item held by rina.
    const isms = fx.ms.isms;
    const soa = { key: 'isms:soa:A.5.23', stage: 'soa', kind: 'soa', id: 'A.5.23', title: ['A.5.23', 'A.5.23'], act: ['Write the justification', 'Tulis justifikasi'], h: 'rina', due: '2026-10-20', st: 'pending', after: false, gate: true, up: [], down: [], q: '', refKey: 'isms:req:A.5.23' };
    isms.bundle.chain.items.push(soa);
    const { app, calls } = await start(readRoutes(fx, me));
    app.state = { ...app.state, screen: 'mytasks' };
    const feed = app.renderVals().tasks.feed as AnyRecord[];
    // Feed items of kinds without an icon of their own (task, soa) show the record icon (kind x).
    const stored = feed.find((x) => x.id === uuidOf('task-1'));
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Upload overdue evidence');
    const soaItem = feed.find((x) => x.id === 'A.5.23' && x.btn === app.t('openGate'));
    expect(soaItem!.btn).toBe(app.t('openGate'));
    soaItem!.go();
    expect(app.state.screen).toBe('controls');
    expect(app.state.tab.controls).toBe('gate');
    expect(calls).toHaveLength(0);
    stored!.go();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/tasks/${uuidOf('task-1')}/complete` });
    // The command reloads the changed system, the organisation and the tasks.
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(['/api/v1/ui/org', '/api/v1/ui/ms/isms', '/api/v1/tasks']));
    expect(app.state.toast).toBe(app.t('toastSaved'));
  });

  it('My Tasks: the evidence hint is the example of the item’s own system (QMS 7.2 and Annex A 7.2, M2-04)', async () => {
    const fx = await wireOf();
    const me = meOf();
    // Evidence of QMS clause 7.2 Competence and of Annex A 7.2 Physical entry, both held by rina, under the same raw key.
    const add = (ms: string, code: string) => {
      const b = fx.ms[ms]!.bundle;
      const req = b.reqs.find((r: AnyRecord) => r.key === '7.2');
      b.evs.push({ ...b.evs[0], code, ctrl: req.id, ctrlKey: '7.2', owner: 'rina' });
      const key = `${ms}:ev:${code}`;
      fx.ms[ms]!.refs[key] = refOf(key, code);
      b.chain.items.push({ key, stage: 'evidence', kind: 'ev', id: code, title: [code, code], act: ['Submit evidence', 'Serahkan bukti'], h: 'rina', due: '2026-10-20', st: 'pending', after: false, gate: false, up: [], down: [], q: '', refKey: key });
    };
    add('isms', 'EV-T72');
    add('qms', 'EQ-T72');
    fx.org.EXAMPLES = { ...fx.org.EXAMPLES, 'isms:7.2': 'Visitor log of the secure area', 'qms:7.2': 'Training record with competence evaluation' };
    const { app } = await start(readRoutes(fx, me));
    app.state = { ...app.state, screen: 'mytasks' };
    const feed = app.renderVals().tasks.feed as AnyRecord[];
    expect(feed.find((x) => x.id === 'EV-T72')!.examples).toBe('Visitor log of the secure area');
    expect(feed.find((x) => x.id === 'EQ-T72')!.examples).toBe('Training record with competence evaluation');
    // Evidence of a system without an example under its key shows the general hint, never another system's example.
    delete fx.org.EXAMPLES['qms:7.2'];
    const again = await start(readRoutes(fx, me));
    again.app.state = { ...again.app.state, screen: 'mytasks' };
    const general = (again.app.renderVals().tasks.feed as AnyRecord[]).find((x) => x.id === 'EQ-T72')!;
    expect(general.examples).toBe('Export, screenshot or signed record dated within the period');
  });

  it('Golden Thread: a broken node shows the clause at risk of its stage in its own system (ABMS control 8.1, M2-04)', async () => {
    const fx = await wireOf();
    const me = meOf();
    expect([fx.org.CLAUSE_AT_RISK['isms:control'], fx.org.CLAUSE_AT_RISK['abms:control']]).toEqual(['6.1.3 d)', '8.1']);
    // A chain of each system whose control node has no record linked (a broken node).
    fx.org.CHAINS = { ...fx.org.CHAINS, isms: [...fx.org.CHAINS.isms, { id: 'R-T01', nodes: [['risk', 'R-014'], ['control', null]] }], abms: [{ id: 'BA-T01', nodes: [['associate', 'BA-T01'], ['control', null]] }] };
    const { app } = await start(readRoutes(fx, me));
    const brokenControl = (ms: string, id: string) => {
      app.state = { ...app.state, ms, gtId: id };
      const nodes = app.gtScreen(app.data(app.MSL.find((m: AnyRecord) => m.id === ms))).gt.nodes as AnyRecord[];
      const node = nodes.find((n) => n.id === '-')!;
      expect(node.stLabel).toBe(app.t('broken'));
      return node.clause;
    };
    expect(brokenControl('abms', 'BA-T01')).toBe('8.1');
    expect(brokenControl('isms', 'R-T01')).toBe('6.1.3 d)');
  });

  it('commands queue behind the busy bar; warnings are added to the toast; errors show the api message', async () => {
    const fx = await wireOf();
    const routes = readRoutes(fx, meOf());
    const { app, calls } = await start(routes);
    const id = app.state.snap.refs['isms:req:A.8.13'].id;
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = json({ ok: true, changed: ['isms'], warnings: [{ rule: 'BR-41', messages: { en: 'Holder has 12 open items', id: 'Pemegang memiliki 12 item terbuka' } }] });
    let maxBusy = 0;
    const set = app.setState;
    app.setState = (u: unknown, cb?: () => void) => { set(u, cb); maxBusy = Math.max(maxBusy, app.state.busy); };
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast(app.t('toastComplete')));
    app.command((ds: AnyRecord) => ds.remindAll('isms'), (r: AnyRecord) => app.toast('second ' + r.ok));
    await settle(app);
    // One command at a time: the second waits for the first (busy never counts two).
    expect(maxBusy).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/api/v1/ms/isms/applicability/${id}/transitions`, '/api/v1/reminders/bulk']);
    expect(app.state.toast).toBe('second true');
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast(app.t('toastComplete')));
    await settle(app);
    expect(app.state.toast).toBe(app.t('toastComplete') + '. Holder has 12 open items');
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = problem(422, 'business-rule', { rule: 'BR-01', messages: { en: 'No valid evidence in the current period', id: 'Tidak ada bukti valid pada periode berjalan' } });
    app.state = { ...app.state, lang: 'id' };
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast('done'));
    await settle(app);
    expect(app.state.toast).toBe('Tidak ada bukti valid pada periode berjalan');
    routes[`POST /api/v1/ms/isms/applicability/${id}/transitions`] = 'network-error';
    app.command((ds: AnyRecord) => ds.markComplete('isms:req:A.8.13'), () => app.toast('done'));
    await settle(app);
    expect(app.state.toast).toBe('Koneksi terputus. Coba lagi.');
    expect(app.state.busy).toBe(0);
  });

  it('remind, remindAll and runCheck use the source and the counts of the result', async () => {
    const fx = await wireOf();
    // Send reminder shows with reminder.send in the system (MILESTONE-2 C.5).
    fx.org.permissions.ms.isms.push('reminder.send');
    const routes = { ...readRoutes(fx, meOf()), 'POST /api/v1/reminders/bulk': json({ ok: true, changed: [], count: 8 }), 'POST /api/v1/ms/isms/link-health/run': json({ ok: true, changed: [], count: 77 }, 202) };
    const { app, calls } = await start(routes);
    app.state = { ...app.state, screen: 'chain' };
    app.renderVals().pageActions[0].go();
    await settle(app);
    expect(app.state.toast).toBe('Reminders sent to 8 holders');
    app.state = { ...app.state, screen: 'fresh' };
    app.renderVals().pageActions[0].go();
    await settle(app);
    expect(app.state.toast).toBe('Integrity check started for 77 references');
    calls.length = 0;
    const d = app.data();
    const det = app.docDetail(d.docs[0], d);
    det.actions.find((a: AnyRecord) => a.label === app.t('remind')).go();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/reminders', body: { ms: 'isms', recipient: d.docs[0].owner } });
  });

  it('the picker lists the repository files; upload uses the hidden file input', async () => {
    const fx = await wireOf();
    const listing = { path: 'Compliance / ISMS', files: [['Backup.xlsx', '28 Sep 2026', 'v3.0', 'quickXorHash', 'Bagus Prasetyo']], refs: [{ repositoryId: 'sp', externalItemId: 'demo-sp-picker-1' }] };
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/storage/repositories/:slug/browse': json(listing) };
    const { app, calls } = await start(routes);
    const ms = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] !== 'vault');
    const ev = app.data(ms).evs[0];
    app.openPicker(`${ms.id}:ev:${ev.code}`, ms, 'ev');
    await vi.waitFor(() => expect(app.state.modal?.listing).toEqual(listing));
    expect(app.modalVals().files[0].name).toBe('Backup.xlsx');
    calls.length = 0;
    app.modalOk();
    await settle(app);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { source: 'link', repository: 'sp', externalItemId: 'demo-sp-picker-1' } });
    expect(app.state.modal).toBeNull();
    // Upload: modalOk opens the file dialog; the chosen file goes to uploadFile.
    const vault = { ...ms, loc: Object.keys(app.D.LOC).find((k) => app.D.LOC[k][1] === 'vault') };
    app.openPicker(`${ms.id}:ev:${ev.code}`, vault, 'ev');
    expect(app.state.modal.type).toBe('upload');
    const input = { accept: '', value: 'x', click: vi.fn() };
    app._file = input;
    app.modalOk();
    expect(input.click).toHaveBeenCalledTimes(1);
    const upload = vi.spyOn(app.ds, 'uploadFile').mockResolvedValue({ ok: true, changed: [] });
    const file = new File(['x'], 'Report.pdf');
    app.onFileChosen({ target: { files: [file] } });
    await settle(app);
    expect(upload).toHaveBeenCalledWith(`${ms.id}:ev:${ev.code}`, file);
    expect(app.state.toast).toBe(app.t('toastUploaded'));
  });

  it('an empty picker listing shows its empty state and keeps Link disabled', async () => {
    const fx = await wireOf();
    const listing = { path: 'Compliance / ISMS / Evidence / 2026 / Q4', files: [], refs: [] };
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/storage/repositories/:slug/browse': json(listing) };
    const { app, calls } = await start(routes);
    const ms = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] !== 'vault');
    const ev = app.data(ms).evs[0];
    app.openPicker(`${ms.id}:ev:${ev.code}`, ms, 'ev');
    await vi.waitFor(() => expect(app.state.modal?.listing).toEqual(listing));
    const vals = app.modalVals();
    expect(vals.files).toEqual([]);
    expect(vals.okOff).toBe(true);
    expect(vals.sub).toMatch(/no files yet/);
    calls.length = 0;
    expect(() => app.modalOk()).not.toThrow();
    await settle(app);
    expect(calls).toHaveLength(0);
    expect(app.state.modal?.type).toBe('picker');
    expect(() => app.renderVals()).not.toThrow();
  });

  it('demo personas: the menu lists them and Sign out; a persona switch takes the role from the new Me', async () => {
    const fx = await wireOf();
    const personas = fx.org.ROLES;
    const me = meOf({ personas });
    const bagus = meOf({ handle: 'bagus', personas, uiRoleByMs: { isms: 'owner', qms: 'owner', bcms: 'owner', abms: 'owner' } });
    const routes = { ...readRoutes(fx, me), 'POST /api/v1/auth/demo/persona': json(bagus), 'POST /api/v1/auth/logout': { status: 204 } } as Routes;
    const { app, calls, ds } = await start(routes);
    const v = app.renderVals();
    expect(v.roleOptions).toHaveLength(Object.keys(personas).length + 1);
    routes['GET /api/v1/me'] = json(bagus);
    app.setRole('owner', 'portfolio', false);
    await vi.waitFor(() => expect(app.state.role).toBe('owner'));
    expect(app.me).toBe('bagus');
    expect(app.state.screen).toBe('mytasks');
    const logout = vi.spyOn(ds, 'logout');
    app.renderVals().roleOptions.slice(-1)[0].go();
    expect(logout).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/v1/auth/logout')).toBe(true));
  });

  it('a failed first load shows the error and Try again loads once more', async () => {
    const fx = await wireOf();
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/ui/org': [problem(503, 'dependency-unavailable', { messages: { en: 'Database busy', id: 'Basis data sibuk' } }), json(fx.org)] } as Routes;
    const env = sourceWith(routes);
    const app = mount(env.ds);
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.loadError).toBeTruthy());
    expect(app.state.D).toBeNull();
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    expect(app.state.loadError).toBeNull();
  });

  it('an organisation switch takes the system list and role of the new organisation; reauth-required shows no toast', async () => {
    const fx = await wireOf();
    const me = meOf({ orgs: [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms', 'qms', 'bcms', 'abms'], deploy: 'saas', sites: 3 }, { id: 'rmn', name: 'RS Medika Nusantara', ms: ['isms'], deploy: 'onprem', sites: 1 }] });
    const rmnMe = { ...meOf({ org: { id: uuidOf('org:rmn'), slug: 'rmn', name: 'RS Medika Nusantara' }, uiRoleByMs: { isms: 'auditor' } }), orgs: me.orgs };
    const routes = { ...readRoutes(fx, me), 'PUT /api/v1/me/org': json(rmnMe) } as Routes;
    const { app } = await start(routes);
    app.state = { ...app.state, ms: 'qms' };
    routes['GET /api/v1/ui/org'] = json({ ...fx.org, orgs: me.orgs, MS: fx.org.MS.filter((m: AnyRecord) => m.id === 'isms') });
    app.setOrg('rmn');
    await vi.waitFor(() => expect(app.state.org).toBe('rmn'));
    expect([app.state.ms, app.state.role, app.state.deploy]).toEqual(['isms', 'auditor', 'onprem']);
    expect(() => app.renderVals()).not.toThrow();
    routes['PUT /api/v1/me/org'] = problem(409, 'reauth-required', { methods: { local: true, providers: [] } });
    app.state = { ...app.state, toast: null };
    app.setOrg('ndt');
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.org).toBe('rmn');
    expect(app.state.toast).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Screen host (MILESTONE-2 C.3 to C.6, M2-01)
// ---------------------------------------------------------------------------------------------------------------

async function sampleApp(props: AnyRecord = {}) {
  const ds = createSampleDataSource();
  const app = mount(ds, props);
  app.firstLoad();
  await vi.waitFor(() => expect(app.state.D).toBeTruthy());
  return app;
}

/** A `Me` of a person with a role or administration rights only, in the organisation `org`. */
function personMe(options: { handle: string; rolesByMs?: Record<string, string[]>; uiRoleByMs?: Record<string, string>; adminRoles?: string[]; platformRoles?: string[]; org?: AnyRecord | null; orgs?: AnyRecord[]; perms: { org: string[]; ms: Record<string, string[]> } }) {
  const base = meOf({ handle: options.handle, uiRoleByMs: options.uiRoleByMs ?? {} });
  return {
    ...base,
    org: options.org === undefined ? base.org : options.org,
    orgs: options.orgs ?? base.orgs,
    rolesByMs: options.rolesByMs ?? {},
    uiRoleByMs: options.uiRoleByMs ?? {},
    adminRoles: options.adminRoles ?? [],
    platformRoles: options.platformRoles ?? [],
    permissions: options.perms,
  };
}

describe('screen host in sample mode', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('every screen, host screens included, renders for every persona in both languages', async () => {
    const app = await sampleApp();
    for (const role of ['manager', 'owner', 'auditor', 'top']) {
      app.state = { ...app.state, role };
      renderAll(app);
    }
  });

  it('the Licence screen: title, breadcrumb, page action, Tera help, body slot and its sidebar entry', async () => {
    const app = await sampleApp();
    app.state = { ...app.state, screen: 'license' };
    const v = app.renderVals();
    expect([v.title, v.crumb1, v.crumb2]).toEqual(['Licence', 'Administration', 'Licence']);
    expect(v.pageActions.map((a: AnyRecord) => a.label)).toEqual(['Install licence']);
    expect(v.tera.how).toHaveLength(3);
    expect(v.hostScreen).toBeTruthy();
    expect(v.hostLayer).toBeTruthy();
    expect([v.isPortfolio, v.isDrill, v.isFw, v.showList]).toEqual([false, false, false, false]);
    const admin = v.nav.find((g: AnyRecord) => g.label === 'Administration');
    expect(admin.items.map((i: AnyRecord) => i.label)).toEqual(['Getting started', 'Framework library', 'Storage repositories', 'Organisation', 'Licence', 'Management systems', 'Routing rules', 'People and roles', 'Pending approvals', 'Access reviews', 'Company sign-in']);
    expect(admin.items[4].fw).toBe(600);
    v.pageActions[0].go();
    expect(app.state.screen).toBe('license');
    expect(app.state.params.install).toEqual(expect.any(Number));
    app.state = { ...app.state, lang: 'id' };
    expect(app.renderVals().title).toBe('Lisensi');
    // Personas without the screen: the owner never sees it; Top Management does (license.read).
    app.state = { ...app.state, lang: 'en', role: 'owner' };
    expect(app.renderVals().nav.flatMap((g: AnyRecord) => g.items.map((i: AnyRecord) => i.label))).not.toContain('Licence');
    app.state = { ...app.state, role: 'top' };
    expect(app.renderVals().nav.flatMap((g: AnyRecord) => g.items.map((i: AnyRecord) => i.label))).toContain('Licence');
  });

  it('?screen= opens a screen at start and switches to its first persona when needed (C.2)', async () => {
    const app = await sampleApp();
    app._start = { screen: 'license', persona: null };
    app.state = { ...app.state, role: 'owner' };
    await app.afterFirstLoad();
    await vi.waitFor(() => expect(app.state.screen).toBe('license'));
    expect(app.state.role).toBe('manager');
    app._start = { screen: 'controls', persona: 'auditor' };
    app.afterFirstLoad();
    expect(app.state.screen).toBe('controls');
    app._start = { screen: 'nothing', persona: null };
    app.state = { ...app.state, screen: 'portfolio' };
    app.afterFirstLoad();
    expect(app.state.screen).toBe('portfolio');
  });

  it('?screen= with a ?persona= the screen does not list keeps that persona on its own landing (C.2)', async () => {
    const app = await sampleApp();
    app._start = { screen: 'license', persona: 'owner' };
    app.state = { ...app.state, role: 'owner', screen: 'portfolio' };
    app.afterFirstLoad();
    expect([app.state.role, app.state.screen]).toEqual(['owner', 'mytasks']);
    app._start = { screen: 'license', persona: 'auditor' };
    app.state = { ...app.state, role: 'auditor', screen: 'portfolio' };
    app.afterFirstLoad();
    expect([app.state.role, app.state.screen]).toEqual(['auditor', 'portfolio']);
    app._start = { screen: 'license', persona: 'top' };
    app.state = { ...app.state, role: 'top', screen: 'portfolio' };
    app.afterFirstLoad();
    expect([app.state.role, app.state.screen]).toEqual(['top', 'license']);
    // A persona alone lands where a persona switch lands.
    app._start = { screen: null, persona: 'owner' };
    app.state = { ...app.state, role: 'owner', screen: 'portfolio' };
    app.afterFirstLoad();
    expect(app.state.screen).toBe('mytasks');
  });

  it('the body of a host screen renders only for a persona that may open it, whatever set the screen (C.2)', async () => {
    const app = await sampleApp();
    app.state = { ...app.state, role: 'owner' };
    app.go('license');
    expect(app.state.screen).toBe('license');
    const v = app.renderVals();
    expect(v.hostScreen).toBeFalsy();
    expect([v.title, v.isTasks]).toEqual(['My Tasks', true]);
    expect(v.pageActions.map((a: AnyRecord) => a.label)).not.toContain('Install licence');
    app.state = { ...app.state, role: 'auditor' };
    const a = app.renderVals();
    expect([a.title, a.isPortfolio, Boolean(a.hostScreen)]).toEqual(['Portfolio Overview', true, false]);
    app.state = { ...app.state, role: 'top' };
    const t = app.renderVals();
    expect([t.title, Boolean(t.hostScreen)]).toEqual(['Licence', true]);
  });

  it('a persona switch away from a host screen the new persona cannot open lands on its own screen', async () => {
    const app = await sampleApp();
    app.state = { ...app.state, screen: 'license' };
    app.setRole('owner', 'license', false);
    await vi.waitFor(() => expect(app.state.role).toBe('owner'));
    expect(app.state.screen).toBe('mytasks');
    app.setRole('top', 'portfolio', false);
    await vi.waitFor(() => expect(app.state.role).toBe('top'));
    app.go('license');
    app.setRole('manager', 'license', false);
    await vi.waitFor(() => expect(app.state.role).toBe('manager'));
    expect(app.state.screen).toBe('license');
  });

  it('Controls: clause entries come first, in the group Clauses 4 to 10, labelled Cl. <code> (D2-09)', async () => {
    const app = await sampleApp();
    const bundle = app.state.D.bundles.isms;
    bundle.reqs = [...clauseFixture(), ...bundle.reqs];
    app.state = { ...app.state, screen: 'controls', chip: { controls: 'all' } };
    const scr = app.controlsScreen(app.data());
    expect(scr.rows[0]).toMatchObject({ isGroup: true, label: 'Clauses 4 to 10', n: 3 });
    expect(scr.rows.slice(1, 4).map((r: AnyRecord) => r.cells[0].v)).toEqual(['Cl. 4.1', 'Cl. 4.2', 'Cl. 5.1']);
    expect(scr.rows[4]).toMatchObject({ isGroup: true, label: 'Annex A controls', n: 93 });
    expect(app.reqDetail(clauseFixture()[2], app.data()).id).toBe('Cl. 5.1');
    app.state = { ...app.state, lang: 'id' };
    expect(app.controlsScreen(app.data()).rows[0].label).toBe('Klausul 4 sampai 10');
    // Without clause entries the list is as before: no group rows.
    bundle.reqs = bundle.reqs.slice(3);
    expect(app.controlsScreen(app.data()).rows.some((r: AnyRecord) => r.isGroup)).toBe(false);
    const v = app.renderVals();
    expect(v.rows[0].isRow).toBe(true);
  });

  it('toast-only actions keep their toast when no package claims them (C.5)', async () => {
    const app = await sampleApp();
    // Packages claim every action id of src/screens/actions.ts by now, so an id no package claims shows the fallback:
    // the toast of the generated view.
    app.claimGo('nobody.claims.this', {}, () => app.toast(app.t('toastEvent')))();
    expect(app.state.toast).toBe(app.t('toastEvent'));
  });

  it('detail objects carry the record kind, key and record for detail extensions (C.5)', async () => {
    const app = await sampleApp();
    const d = app.data();
    expect(app.reqDetail(d.reqs[0], d).ext).toMatchObject({ kind: 'req', ms: 'isms', key: 'isms:req:' + d.reqs[0].id });
    expect(app.docDetail(d.docs[0], d).ext.kind).toBe('doc');
    expect(app.evDetail(d.evs[0], d).ext.kind).toBe('ev');
    const item = app.chain(d).items.find((i: AnyRecord) => i.kind === 'x');
    expect(app.itemDetail(item, d).ext).toMatchObject({ kind: 'item', key: item.key });
    const act = d.phases[0].acts[0];
    expect(app.actDetail(act, d.phases[0], d).ext).toMatchObject({ kind: 'activity', key: act.key });
    // No package adds an extension yet, so every slot stays empty.
    app.state = { ...app.state, screen: 'controls', sel: 'isms:req:' + d.reqs[0].id };
    app.renderVals();
    app.state = { ...app.state, sel: null };
    expect(app.renderVals().hostDetail).toBeNull();
  });

  it('the readiness block is the Internal progress score with its method (D2-11, H.2)', async () => {
    const app = await sampleApp();
    app.state = { ...app.state, screen: 'm1overview' };
    const ov = app.renderVals().ov;
    expect(ov.scoreTitle).toBe('Internal progress score');
    expect(ov.scoreMethod).toBe('Average of documents in place, entries implemented, evidence fresh and metrics current per clause');
    app.state = { ...app.state, lang: 'id' };
    expect(app.renderVals().ov.scoreTitle).toBe('Skor progres internal');
  });
});

describe('sample source changes for sample adapters (C.6)', () => {
  it('mutate changes a record and insert adds one; the reload shows both on the built-in screens', async () => {
    const ds = createSampleDataSource() as AnyRecord;
    const snap = await ds.load();
    const before = snap.bundles.isms.reqs[0];
    expect(await ds.mutate('isms', 'req', before.id, { title: 'Changed title' })).toEqual({ ok: true, changed: ['isms'] });
    expect(await ds.insert('isms', 'doc', { id: 'POL-99', title: 'New policy', tier: 'Policy', ver: '0.1', st: 'draft', appr: '', rev: '2027-10-01', owner: 'rina', shared: false, ms: 'isms' })).toMatchObject({ ok: true });
    expect(await ds.insert('isms', 'event', { t: ['Internal audit', 'Audit internal'], d: '2026-12-01', days: 2 })).toMatchObject({ ok: true });
    const prep = snap.PREP.isms[0];
    expect(await ds.mutate('isms', 'prep', prep[0], { 3: 'done' })).toMatchObject({ ok: true });
    expect(await ds.insert('isms', 'x:risk', { id: 'R-900', t: 'New risk', act: 'Assess', h: 'rina', due: '2026-11-30' })).toMatchObject({ ok: true });
    const next = await ds.reload(snap, ['isms']);
    expect(next.bundles.isms.reqs[0].title).toBe('Changed title');
    expect(next.bundles.isms.docs.find((x: AnyRecord) => x.id === 'POL-99')).toMatchObject({ title: 'New policy', st: 'draft' });
    expect(next.EVENTS.isms.at(-1)).toMatchObject({ d: '2026-12-01' });
    expect(next.PREP.isms[0][3]).toBe('done');
    expect(next.bundles.isms.chain.items.some((i: AnyRecord) => i.id === 'R-900')).toBe(true);
    // Unchanged systems keep their bundles; evidence still comes from the pack's controls only.
    expect(next.bundles.qms).toBe(snap.bundles.qms);
    expect(next.bundles.isms.evs.length).toBe(snap.bundles.isms.evs.length);
  });

  it('refuses unknown records, kinds, systems and duplicate ids', async () => {
    const ds = createSampleDataSource({ org: 'rmn' }) as AnyRecord;
    await ds.load();
    expect((await ds.mutate('isms', 'req', 'A.99.99', { title: 'x' })).error.status).toBe(404);
    expect((await ds.mutate('qms', 'req', 'Cl. 4.1', { title: 'x' })).error.status).toBe(404);
    expect((await ds.mutate('isms', 'policy', 'x', {})).error.status).toBe(422);
    expect((await ds.insert('isms', 'req', { title: 'no id' })).error.status).toBe(422);
    expect((await ds.insert('isms', 'req', { id: 'A.5.1', title: 'duplicate' })).error.status).toBe(409);
  });
});

describe('screen host in API mode', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the top bar shows the label of the role the person holds: one distinct label per business role', async () => {
    const fx = await wireOf();
    const ui: Record<string, string> = { ms_manager: 'manager', programme_owner: 'manager', domain_owner: 'owner', risk_owner: 'owner', internal_auditor: 'auditor', top_management: 'top', external_auditor: 'auditor', compliance_investigator: 'owner' };
    const shown = new Set<string>();
    for (const [role, label] of Object.entries(BUSINESS_ROLE_LABELS)) {
      const me = personMe({ handle: 'rina', rolesByMs: { isms: [role] }, uiRoleByMs: { isms: ui[role] }, orgs: [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: ['isms'], deploy: 'saas', sites: 3 }], perms: { org: [], ms: { isms: ['ms.read'] } } });
      const { app } = await start(readRoutes(fx, me));
      const v = app.renderVals();
      expect(v.me.role, role).toBe(`${label[0]}, ${app.personOf('rina')[1]}`);
      expect(v.roleOptions[0].label, role).toBe(label[0]);
      shown.add(v.me.role.split(',')[0]);
      app.state = { ...app.state, lang: 'id' };
      expect(app.renderVals().me.role.startsWith(label[1])).toBe(true);
    }
    expect(shown.size).toBe(8);
  });

  it('no-system path: a Tenant Admin without a business role lands on Getting started with the Administration group', async () => {
    const fx = await wireOf();
    const me = personMe({ handle: 'tenant.admin', adminRoles: ['tenant_admin'], org: { id: uuidOf('org:ndt'), slug: 'ndt', name: 'PT Nusantara Digital Teknologi' }, orgs: [{ id: 'ndt', name: 'PT Nusantara Digital Teknologi', ms: [], deploy: 'saas', sites: 3 }], perms: { org: ['license.read', 'license.manage', 'storage.repository.read', 'pack.read', 'ms.admin'], ms: {} } });
    const org = { ...fx.org, orgs: me.orgs, permissions: me.permissions };
    const { app, calls } = await start({ ...readRoutes(fx, me), 'GET /api/v1/ui/org': json(org) });
    expect(app.MSL).toEqual([]);
    expect(calls.filter((c) => c.path.startsWith('/api/v1/ui/ms/'))).toHaveLength(0);
    app.afterFirstLoad();
    // M2-16: Getting started is the first Administration screen (order 5), so it is the landing.
    expect(app.state.screen).toBe('getting-started');
    expect(app.shellWithoutSystem()).toBe(true);
    const v = app.renderVals();
    expect(v.msSwitch).toBe(false);
    expect(v.nav.map((g: AnyRecord) => [g.label, g.items.map((i: AnyRecord) => i.label)])).toEqual([['Administration', ['Getting started', 'Framework library', 'Storage repositories', 'Licence', 'Management systems', 'Routing rules']]]);
    expect(v.title).toBe('Getting started');
    expect(v.me.role).toMatch(/^Tenant Admin, /);
    expect(v.pack).toBe('-');
    // The built-in Administration screens render without a system; the others show the notice in the shell.
    for (const screen of ['fw', 'storage']) {
      app.state = { ...app.state, screen };
      const w = app.renderVals();
      expect(w.hostScreen, screen).toBeNull();
      expect(w.pageActions.length, screen).toBeGreaterThan(0);
    }
    app.state = { ...app.state, screen: 'storage' };
    expect(app.renderVals().st.repos.length).toBe(fx.org.REPOS.length);
    app.state = { ...app.state, screen: 'controls' };
    const n = app.renderVals();
    expect(n.hostScreen).toBeTruthy();
    expect(n.pageActions).toEqual([]);
    expect(n.isDrill).toBe(false);
    renderAll(app);
  });

  it('a platform operator without a membership: no organisation snapshot is read and the no-system message stays', async () => {
    const me = personMe({ handle: 'ops', org: null, orgs: [], platformRoles: ['platform_operator'], perms: { org: ['ops.read', 'ops.tenants.manage'], ms: {} } });
    const { app, calls } = await start({ 'GET /api/v1/me': json(me) });
    expect(app.state.loadError).toBeNull();
    expect(calls).toEqual([]);
    expect(app.D.MS).toEqual([]);
    expect(app.org.name).toBe('Platform operations');
    expect(app.MSL).toEqual([]);
    const platform = HOST_SCREENS.some((d) => d.scope === 'platform');
    expect(app.shellWithoutSystem()).toBe(platform);
    expect(() => app.renderVals()).not.toThrow();
    expect(app.renderVals().me.role).toMatch(/^Platform Operator/);
  });

  it('a null readiness shows Not computed yet on the portfolio and the overview, never 0 (D.3)', async () => {
    const fx = await wireOf();
    fx.org.MS[0] = { ...fx.org.MS[0], clauses: [null, null, null, null, null, null, null] };
    const { app } = await start(readRoutes(fx, meOf()));
    const ms = app.D.MS[0];
    expect(ms.clauseLabels).toEqual(Array(7).fill(NOT_COMPUTED));
    expect(app.D.MS[1].clauseLabels[0]).toBe(`${app.D.MS[1].clauses[0]}%`);
    app.state = { ...app.state, screen: 'portfolio' };
    const card = app.renderVals().pf.find((c: AnyRecord) => c.id === ms.id);
    expect(card.cl.map((c: AnyRecord) => [c.pctText, c.pctShort, c.pct])).toEqual(Array(7).fill(['Not computed yet', '-', 0]));
    app.state = { ...app.state, screen: 'm1overview', ms: ms.id };
    const ov = app.renderVals().ov;
    expect(ov.clauses.map((c: AnyRecord) => [c.level, c.levelLabel])).toEqual(Array(7).fill(['-', 'Not computed yet']));
    expect(ov.clauses[0].cells[0].title).toBe('Documented: Not computed yet');
    expect(ov.scoreMethod).toMatch(/^Not computed yet/);
    app.state = { ...app.state, lang: 'id' };
    expect(app.renderVals().ov.clauses[0].levelLabel).toBe('Belum dihitung');
    app.state = { ...app.state, screen: 'portfolio' };
    expect(app.renderVals().pf.find((c: AnyRecord) => c.id === ms.id).cl[0].pctText).toBe('Belum dihitung');
  });

  it('stored readiness dimensions replace the offset formula of Milestone 1 (D.6)', async () => {
    const fx = await wireOf();
    const groups = Array.from({ length: 7 }, (_, i) => ({ documented: 100, implemented: 50, evidenced: i === 0 ? null : 75, measured: null }));
    fx.org.MS[0] = { ...fx.org.MS[0], clauses: [75, 75, 75, 75, 75, 75, 75], readiness: { computedAt: '2026-10-28T02:30:00Z', groups } };
    const { app } = await start(readRoutes(fx, meOf()));
    app.state = { ...app.state, screen: 'm1overview', ms: fx.org.MS[0].id };
    const ov = app.renderVals().ov;
    expect(ov.clauses[0].cells.map((c: AnyRecord) => c.title)).toEqual(['Documented: 4 / 4', 'Implemented: 2 / 4', 'Evidenced: No records of this kind', 'Measured: No records of this kind']);
    expect(ov.clauses[0].level).toBe('3.0');
    expect(ov.clauses[1].level).toBe('3.0');
  });

  it('Reassign, Change due date and Send reminder show only with record.assign and reminder.send (C.5)', async () => {
    const { routes } = await acme();
    const { app } = await start(routes);
    const d = app.data(app.MSL.find((m: AnyRecord) => m.id === 'isms'));
    const labels = (det: AnyRecord) => det.actions.map((a: AnyRecord) => a.label);
    const req = d.reqs.find((c: AnyRecord) => !c.gate);
    expect(labels(app.reqDetail(req, d))).not.toContain(app.t('remind'));
    expect(labels(app.reqDetail(req, d))).not.toContain(app.t('reassign'));
    const item = app.chain(d).items[0];
    const itemLabels = labels(app.itemDetail({ ...item, kind: 'x', ref: undefined }, d));
    expect(itemLabels).not.toContain(app.t('changeDue'));
    expect(itemLabels).toContain(app.t('trace'));
    // With the permissions the buttons are back.
    app.state.D.permissions.ms.isms.push('record.assign', 'reminder.send');
    expect(labels(app.reqDetail(req, d))).toEqual(expect.arrayContaining([app.t('remind'), app.t('reassign')]));
    expect(labels(app.itemDetail({ ...item, kind: 'x', ref: undefined }, d))).toEqual(expect.arrayContaining([app.t('remind'), app.t('reassign'), app.t('changeDue')]));
  });

  it('ctx.openPicker resolves the chosen file without attaching it, and null when cancelled (C.4)', async () => {
    const fx = await wireOf();
    const listing = { path: 'Compliance / ISMS / Documents', files: [['Policy.docx', '28 Sep 2026', 'v3.0', 'quickXorHash', 'Rina Kusuma']], refs: [{ repositoryId: 'sp', externalItemId: 'item-1', externalVersionId: '3.0' }] };
    const routes = { ...readRoutes(fx, meOf()), 'GET /api/v1/storage/repositories/:slug/browse': json(listing) };
    const { app, calls } = await start(routes);
    const ms = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] !== 'vault');
    const recordId = uuidOf('doc-1');
    const chosen = app.hostCtx().openPicker({ ms: ms.id, kind: 'document', recordId });
    await vi.waitFor(() => expect(app.state.modal?.type).toBe('picker'));
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/v1/storage/repositories/${ms.loc}/browse` });
    expect(calls[0].url).toContain(`recordId=${recordId}`);
    expect(app.modalVals().title).toBe('Select document file from repository');
    app.modalOk();
    expect(await chosen).toEqual({ source: 'link', repository: 'sp', externalItemId: 'item-1', externalVersionId: '3.0', fileName: 'Policy.docx' });
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(app.state.modal).toBeNull();
    const cancelled = app.hostCtx().openPicker({ ms: ms.id, kind: 'evidence', recordId });
    await vi.waitFor(() => expect(app.state.modal?.type).toBe('picker'));
    app.renderVals().closeModal();
    expect(await cancelled).toBeNull();
  });

  it('ctx.openPicker with the Managed Vault uploads the chosen file and resolves the upload intent', async () => {
    const fx = await wireOf();
    const routes = {
      ...readRoutes(fx, meOf()),
      'POST /api/v1/storage/upload-intents': json({ intentId: uuidOf('intent'), mode: 'stored', repository: { slug: 'vault', name: 'Managed Vault', adapter: 'managed_vault' }, contentUrl: `/api/v1/storage/upload-intents/${uuidOf('intent')}/content`, maxBytes: 1000, expiresAt: '2026-09-29T07:00:00Z', correlationCode: 'c', folderPath: 'x' }),
      'PUT /api/v1/storage/upload-intents/:id/content': json({ storageObjectId: uuidOf('obj'), hashAlgorithm: 'sha256', hashValue: 'a', sizeBytes: 1, versionLabel: 'v1' }),
    } as Routes;
    const { app, calls } = await start(routes);
    const vault = app.MSL.find((m: AnyRecord) => app.D.LOC[m.loc][1] === 'vault');
    const chosen = app.hostCtx().openPicker({ ms: vault.id, kind: 'evidence', recordId: uuidOf('ev-1') });
    await vi.waitFor(() => expect(app.state.modal?.type).toBe('upload'));
    const input = { accept: '', value: 'x', click: vi.fn() };
    app._file = input;
    app.modalOk();
    expect(input.click).toHaveBeenCalledTimes(1);
    app.onFileChosen({ target: { files: [new File(['x'], 'Log.pdf')] } });
    expect(await chosen).toEqual({ source: 'upload', uploadIntentId: uuidOf('intent'), fileName: 'Log.pdf' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/storage/upload-intents', `PUT /api/v1/storage/upload-intents/${uuidOf('intent')}/content`]);
    expect(calls[0].body).toMatchObject({ ms: vault.id, kind: 'evidence', recordId: uuidOf('ev-1'), fileName: 'Log.pdf' });
  });
});

describe('preferences of the boot (C.3)', () => {
  it('apply language, theme and density unless the address sets them', async () => {
    const { withPreferences } = await import('../../src/auth/boot');
    const settings = { drillPattern: 'panel', density: 'comfortable', overviewLayout: 'cards', font: 'plex', lang: 'en', theme: 'light', deploy: 'saas' } as const;
    expect(withPreferences(settings, { language: 'id', theme: 'dark', density: 'dense' }, '')).toMatchObject({ lang: 'id', theme: 'dark', density: 'dense' });
    expect(withPreferences(settings, { lang: 'id', theme: 'dark' }, '?theme=light&lang=en')).toMatchObject({ lang: 'en', theme: 'light' });
    // An invalid address value does not count as set; an unknown preference is ignored.
    expect(withPreferences(settings, { theme: 'dark', density: 'huge' }, '?theme=neon')).toMatchObject({ theme: 'dark', density: 'comfortable' });
    expect(withPreferences(settings, null, '')).toEqual(settings);
  });
});
