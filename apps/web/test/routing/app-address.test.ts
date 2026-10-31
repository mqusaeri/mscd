// The controller and the address (MILESTONE-2 M2-20): MscdApp over a fake browser (location, history and popstate). The sample build keeps its place in the hash, the API build in the path; a new screen or
// organisation adds a history entry, a new system or tab replaces it; Back and Forward open the place of the entry;
// an address the session cannot open opens the start screen and is corrected; an organisation switch that asks for a
// new sign-in is not asked again when the person went back to the old session.
// MscdApp is used as a plain object, as in test/api/controller.test.ts; setState merges at once and calls
// componentDidUpdate, which writes the address as React would after the update.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MscdApp from '../../src/MscdApp.jsx';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { forgetOrgTried, orgTried, rememberOrgTried } from '../../src/routing';
import { json, meOf, readRoutes, sourceWith, wireOf } from '../api/fixtures';
import type { Routes } from '../api/fixtures';
import { problem } from '../auth/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/** A browser tab: the history entries, the current one, what was written and the window listeners. */
function browser(url: string) {
  const entries = [url];
  let index = 0;
  const ops: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const current = () => new URL(entries[index], 'http://localhost');
  const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());
  const win = {
    location: {
      get pathname() { return current().pathname; },
      get search() { return current().search; },
      get hash() { return current().hash; },
    },
    history: {
      pushState(_: unknown, __: string, u: string) { entries.splice(index + 1); entries.push(u); index++; ops.push(`push ${u}`); },
      replaceState(_: unknown, __: string, u: string) { entries[index] = u; ops.push(`replace ${u}`); },
      back() { index--; queueMicrotask(() => fire('popstate')); },
    },
    addEventListener(type: string, fn: () => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
    removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); },
    scrollTo() {},
  };
  return {
    win,
    ops,
    get url() { return entries[index]; },
    get entries() { return [...entries]; },
    /** Back or Forward by `n` entries, as the browser does it: the entry changes, then popstate. */
    go(n: number) { index += n; fire('popstate'); },
    /** A hash typed in the address bar: a new entry, then popstate and hashchange. */
    type(u: string) { entries.splice(index + 1); entries.push(u); index++; fire('popstate'); fire('hashchange'); },
  };
}

function mount(props: AnyRecord = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the controller is a JavaScript class
  const app = new (MscdApp as any)({ lang: 'en', theme: 'light', deploy: 'saas', ...props }) as AnyRecord;
  app.setState = (u: unknown, cb?: () => void) => {
    const prev = app.state;
    const patch = typeof u === 'function' ? (u as (s: AnyRecord, p: AnyRecord) => AnyRecord)(app.state, app.props) : u;
    if (patch) {
      app.state = { ...app.state, ...(patch as AnyRecord) };
      app.componentDidUpdate(app.props, prev);
    }
    if (cb) cb();
  };
  return app;
}

/** The sample build opened at `url`. */
async function sampleAt(url: string) {
  const tab = browser(url);
  vi.stubGlobal('window', tab.win);
  const app = mount();
  app.componentDidMount();
  await vi.waitFor(() => expect(app.state.D).toBeTruthy());
  await vi.waitFor(() => expect(app._nav).toBeNull());
  return { app, tab };
}

describe('the sample build keeps its place in the hash', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('opens the screen, system and organisation of the hash and writes nothing when the address is already right', async () => {
    const { app, tab } = await sampleAt('/#/controls?ms=qms&org=ndt');
    expect([app.state.screen, app.state.ms, app.state.org]).toEqual(['controls', 'qms', 'ndt']);
    expect(tab.ops).toEqual([]);
  });

  it('turns the start query of C.2 into a hash address, keeping the display settings', async () => {
    const { app, tab } = await sampleAt('/?lang=id&screen=license&persona=top');
    expect([app.state.role, app.state.screen]).toEqual(['top', 'license']);
    expect(tab.ops).toEqual(['replace /?lang=id#/license?ms=isms&org=ndt&persona=top']);
  });

  it('a new screen adds an entry, a new system or tab replaces it, and Back and Forward open the entries', async () => {
    const { app, tab } = await sampleAt('/');
    expect(tab.ops).toEqual(['replace /#/portfolio?ms=isms&org=ndt']);
    app.go('controls');
    app.setMs('qms');
    app.go('findings');
    app.setHostTab('actions');
    expect(app.hostCtx().tab).toBe('actions');
    expect(tab.ops.slice(1)).toEqual([
      'push /#/controls?ms=isms&org=ndt',
      'replace /#/controls?ms=qms&org=ndt',
      'push /#/findings?ms=qms&org=ndt',
      'replace /#/findings?ms=qms&org=ndt&tab=actions',
    ]);
    expect(tab.entries).toEqual(['/#/portfolio?ms=isms&org=ndt', '/#/controls?ms=qms&org=ndt', '/#/findings?ms=qms&org=ndt&tab=actions']);
    // Choosing the same tab again writes nothing.
    app.setHostTab('actions');
    expect(tab.ops).toHaveLength(5);

    tab.go(-1);
    expect([app.state.screen, app.state.ms, app.state.htab]).toEqual(['controls', 'qms', null]);
    tab.go(-1);
    expect([app.state.screen, app.state.ms]).toEqual(['portfolio', 'isms']);
    tab.go(2);
    expect([app.state.screen, app.state.ms]).toEqual(['findings', 'qms']);
    expect(app.hostCtx().tab).toBe('actions');
    // Opening a place from the history writes nothing new.
    expect(tab.ops).toHaveLength(5);
  });

  it('a host screen opened with params.tab shows that tab; another screen starts at its first tab', async () => {
    const { app, tab } = await sampleAt('/#/findings?ms=isms&org=ndt&tab=self');
    expect(app.hostCtx().tab).toBe('self');
    app.go('registers', { params: { tab: 'risks' } });
    expect(app.hostCtx().tab).toBe('risks');
    expect(tab.url).toBe('/#/registers?ms=isms&org=ndt&tab=risks');
    app.go('findings');
    expect(app.hostCtx().tab).toBeNull();
    expect(tab.url).toBe('/#/findings?ms=isms&org=ndt');
  });

  it('an unknown screen, or one the persona cannot open, opens the start screen and corrects the address', async () => {
    const unknown = await sampleAt('/#/nothing?ms=zzz');
    expect(unknown.app.state.screen).toBe('portfolio');
    expect(unknown.tab.ops).toEqual(['replace /#/portfolio?ms=isms&org=ndt']);
    vi.unstubAllGlobals();
    const owner = await sampleAt('/#/license?persona=owner');
    expect([owner.app.state.role, owner.app.state.screen]).toEqual(['owner', 'mytasks']);
    expect(owner.tab.ops).toEqual(['replace /#/mytasks?ms=isms&org=ndt&persona=owner']);
  });

  it('a hash typed in the address bar switches persona and organisation, once for popstate and hashchange together', async () => {
    const { app, tab } = await sampleAt('/#/controls?ms=isms&org=ndt&persona=owner');
    expect(app.state.role).toBe('owner');
    tab.type('/#/fw?org=bsd');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.org, app.state.role, app.state.screen, app.state.deploy]).toEqual(['bsd', 'manager', 'fw', 'onprem']);
    expect(tab.url).toBe('/#/fw?ms=isms&org=bsd');
  });

  it('opens the organisation the hash names from the start; an unknown one keeps the first', async () => {
    const { app } = await sampleAt('/#/storage?org=rmn');
    expect([app.state.org, app.state.screen, app.state.deploy]).toEqual(['rmn', 'storage', 'saas']);
    vi.unstubAllGlobals();
    const other = await sampleAt('/#/storage?org=zzz');
    expect(other.app.state.org).toBe('ndt');
    expect(other.tab.url).toBe('/#/storage?ms=isms&org=ndt');
  });

  it('the organisation menu adds one entry; Back returns to the organisation before', async () => {
    const { app, tab } = await sampleAt('/#/controls?ms=qms&org=ndt');
    app.setOrg('rmn');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect(tab.ops).toEqual(['push /#/?org=rmn', 'replace /#/m1overview?ms=isms&org=rmn']);
    expect([app.state.org, app.state.screen]).toEqual(['rmn', 'm1overview']);
    tab.go(-1);
    await vi.waitFor(() => expect(app.state.org).toBe('ndt'));
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.screen, app.state.ms]).toEqual(['controls', 'qms']);
  });

  it('a fragment that is no address is left alone', async () => {
    const { app, tab } = await sampleAt('/#/controls?ms=isms&org=ndt');
    tab.type('/#top');
    expect(app.state.screen).toBe('controls');
    expect(tab.ops).toEqual([]);
  });

  it('the source is created with the persona of the hash', async () => {
    const { app } = await sampleAt('/#/mytasks?persona=auditor');
    expect(app.state.role).toBe('auditor');
    expect(app.state.screen).toBe('mytasks');
  });

  it('stops listening when it unmounts', async () => {
    const { app, tab } = await sampleAt('/#/controls?ms=isms&org=ndt');
    app.componentWillUnmount();
    tab.type('/#/docs?ms=isms&org=ndt');
    expect(app.state.screen).toBe('controls');
  });
});

describe('the API build keeps its place in the path', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('VITE_DATA_SOURCE', 'api');
    // Each test is a new page: no organisation switch was tried yet.
    forgetOrgTried();
  });
  afterEach(() => { forgetOrgTried(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  /**
   * Rina in ndt, also a member of bsd. A switch to bsd answers 409 reauth-required, or with `switchOk` the `Me` of bsd
   * (a new session). `loaded: false` does not wait for the first snapshot. `roles` are her UI roles per system in ndt,
   * `systems` the systems of ndt (default all four); `strict` mounts the app twice, as React StrictMode does in
   * development (mount, unmount, mount). Opening the app again in one test is the boot router opening it again in the
   * same page (after Cancel on the sign-in page, or a new sign-in), so the memory of a tried switch stays.
   */
  async function apiAt(url: string, { switchOk = false, loaded = true, roles = undefined as Record<string, string> | undefined, systems = undefined as string[] | undefined, strict = false } = {}) {
    const fx = await wireOf();
    const ndt = fx.org.orgs.find((o: AnyRecord) => o.id === 'ndt');
    const orgs = [systems ? { ...ndt, ms: systems } : ndt, { ...fx.org.orgs.find((o: AnyRecord) => o.id === 'bsd') }];
    const me = meOf({ orgs, ...(roles ? { uiRoleByMs: roles } : {}) });
    const bsd = meOf({ orgs, org: { id: 'org-bsd', slug: 'bsd', name: 'PT Bank Sentosa Digital' }, uiRoleByMs: { isms: 'manager', qms: 'manager' } });
    const routes: Routes = {
      ...readRoutes(fx, me),
      'GET /api/v1/ui/org': json({ ...fx.org, orgs }),
      'PUT /api/v1/me/org': switchOk ? json(bsd) : problem(409, 'reauth-required', { methods: { local: true, providers: [] } }),
    };
    const env = sourceWith(routes);
    const tab = browser(url);
    vi.stubGlobal('window', tab.win);
    const app = mount({ dataSource: env.ds });
    app.componentDidMount();
    if (strict) {
      app.componentWillUnmount();
      app.componentDidMount();
    }
    if (loaded) await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    return { app, tab, env };
  }

  const calls = (env: { calls: { method: string; path: string }[] }, call: string) => env.calls.filter((c) => `${c.method} ${c.path}` === call).length;

  it('opens the path and its values; a person in several organisations gets the organisation in the address', async () => {
    const { app, tab } = await apiAt('/controls?ms=qms&lang=id');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.screen, app.state.ms]).toEqual(['controls', 'qms']);
    expect(tab.ops).toEqual(['replace /controls?ms=qms&org=ndt&lang=id']);
    app.go('docs');
    expect(tab.url).toBe('/docs?ms=qms&org=ndt&lang=id');
    app.setMs('isms');
    expect(tab.entries).toEqual(['/controls?ms=qms&org=ndt&lang=id', '/docs?ms=isms&org=ndt&lang=id']);
  });

  it('an unknown screen, or a screen the session cannot open, opens the start screen', async () => {
    const { app, tab } = await apiAt('/ops?tab=orgs');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect(app.state.screen).toBe('portfolio');
    expect(tab.ops).toEqual(['replace /portfolio?ms=isms&org=ndt']);
  });

  it('the start screen is the landing of the role (product owner, 2026-10-31), and a refresh keeps it', async () => {
    // A Domain Owner of several systems opens My Tasks, as a persona switch lands.
    const roles = { isms: 'owner', qms: 'owner', bcms: 'owner', abms: 'owner' };
    const first = await apiAt('/', { roles });
    await vi.waitFor(() => expect(first.app._nav).toBeNull());
    expect([first.app.state.role, first.app.state.screen]).toEqual(['owner', 'mytasks']);
    expect(first.tab.ops).toEqual(['replace /mytasks?ms=isms&org=ndt']);
    first.app.componentWillUnmount();
    vi.unstubAllGlobals();
    const refresh = await apiAt('/mytasks?ms=isms&org=ndt', { roles });
    await vi.waitFor(() => expect(refresh.app._nav).toBeNull());
    expect(refresh.app.state.screen).toBe('mytasks');
    expect(refresh.tab.ops).toEqual([]);
    // A screen of her sidebar keeps its address; the portfolio, which her sidebar does not have, and a screen she
    // cannot open give her start screen.
    refresh.app.go('controls');
    expect(refresh.tab.url).toBe('/controls?ms=isms&org=ndt');
    refresh.tab.type('/portfolio?ms=isms&org=ndt');
    expect(refresh.app.state.screen).toBe('mytasks');
    expect(refresh.tab.url).toBe('/mytasks?ms=isms&org=ndt');
    refresh.tab.type('/timeline?ms=isms&org=ndt');
    expect(refresh.app.state.screen).toBe('mytasks');
    expect(refresh.tab.url).toBe('/mytasks?ms=isms&org=ndt');
  });

  it('an Internal Auditor of a single-system organisation starts on Audit readiness', async () => {
    const { app, tab } = await apiAt('/', { roles: { isms: 'auditor' }, systems: ['isms'] });
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.role, app.state.screen]).toEqual(['auditor', 'audit']);
    expect(tab.ops).toEqual(['replace /audit?ms=isms&org=ndt']);
    // The portfolio of a single-system organisation is no screen of hers: its address opens the start screen.
    tab.type('/portfolio?ms=isms&org=ndt');
    expect(app.state.screen).toBe('audit');
    expect(tab.url).toBe('/audit?ms=isms&org=ndt');
  });

  it('mounted twice (React StrictMode in development), the first load and the organisation switch run once', async () => {
    const { app, tab, env } = await apiAt('/controls?ms=qms&org=bsd', { switchOk: true, strict: true });
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.org, app.state.ms, app.state.screen]).toEqual(['bsd', 'qms', 'controls']);
    // No plain load of ndt runs next to the switch, so no read meets the session id the switch replaces.
    expect(calls(env, 'GET /api/v1/me')).toBe(1);
    expect(calls(env, 'PUT /api/v1/me/org')).toBe(1);
    expect(calls(env, 'GET /api/v1/ui/org')).toBe(1);
    expect(tab.ops).toEqual([]);
    expect(orgTried()).toBeNull();
    // The second mount listens to Back and Forward again.
    app.go('docs');
    tab.go(-1);
    expect(app.state.screen).toBe('controls');
  });

  it('a start address without the tried organisation forgets the tried switch, so a later address of it switches again', async () => {
    // The person left the sign-in page of a switch to bsd by an address without an organisation (the link of a
    // message, Back), and the boot router opened the app again in the same page.
    rememberOrgTried('bsd');
    const left = await apiAt('/controls?ms=isms');
    await vi.waitFor(() => expect(left.app._nav).toBeNull());
    expect(orgTried()).toBeNull();
    expect(left.app.state.org).toBe('ndt');
    left.app.componentWillUnmount();
    vi.unstubAllGlobals();
    // A copied address of bsd switches organisation instead of being corrected without asking.
    const copied = await apiAt('/controls?ms=isms&org=bsd', { switchOk: true });
    await vi.waitFor(() => expect(copied.app._nav).toBeNull());
    expect(calls(copied.env, 'PUT /api/v1/me/org')).toBe(1);
    expect(copied.app.state.org).toBe('bsd');
    copied.app.componentWillUnmount();
    vi.unstubAllGlobals();
    // A tried switch of another organisation is replaced by the one the address names.
    rememberOrgTried('rmn');
    const other = await apiAt('/controls?ms=isms&org=bsd', { switchOk: true });
    await vi.waitFor(() => expect(other.app._nav).toBeNull());
    expect(calls(other.env, 'PUT /api/v1/me/org')).toBe(1);
    expect(other.app.state.org).toBe('bsd');
    expect(orgTried()).toBeNull();
  });

  it('a tried switch is kept in the page only: nothing of it is left in the browser storage of the tab', async () => {
    const writes: string[] = [];
    const store = { getItem: () => null, setItem: (k: string) => void writes.push(k), removeItem: (k: string) => void writes.push(k), clear: () => {}, key: () => null, length: 0 };
    vi.stubGlobal('sessionStorage', store);
    vi.stubGlobal('localStorage', store);
    const first = await apiAt('/controls?ms=isms&org=bsd', { loaded: false });
    await vi.waitFor(() => expect(first.env.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/me/org')).toBe(true));
    expect(orgTried()).toBe('bsd');
    expect(writes.filter((k) => k.startsWith('mscd.route'))).toEqual([]);
  });

  it('sign-in addresses belong to the boot router: nothing is read or written there', async () => {
    const { app, tab } = await apiAt('/');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    tab.type('/login');
    app.go('docs');
    expect(tab.url).toBe('/login');
    expect(app.state.screen).toBe('docs');
  });

  it('another organisation of the address is switched to before the first snapshot', async () => {
    const { app, tab, env } = await apiAt('/controls?ms=qms&org=bsd', { switchOk: true });
    await vi.waitFor(() => expect(app._nav).toBeNull());
    expect([app.state.org, app.state.ms, app.state.screen]).toEqual(['bsd', 'qms', 'controls']);
    // The switch comes before the reads of the organisation: nothing of ndt loads with the session the switch replaces.
    const order = env.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.slice(0, 3)).toEqual(['GET /api/v1/me', 'PUT /api/v1/me/org', 'GET /api/v1/ui/org']);
    expect(order.filter((c) => c === 'PUT /api/v1/me/org')).toHaveLength(1);
    expect(tab.ops).toEqual([]);
    expect(orgTried()).toBeNull();
  });

  it('an organisation that asks for a new sign-in: the switch waits for the sign-in page, and is not asked again after Cancel', async () => {
    const first = await apiAt('/controls?ms=isms&org=bsd', { loaded: false });
    await vi.waitFor(() => expect(first.env.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/me/org')).toBe(true));
    // The boot router shows the sign-in page now; the app shows no organisation, writes nothing and keeps the slug.
    expect(first.app.state.D).toBeNull();
    expect(first.tab.ops).toEqual([]);
    expect(orgTried()).toBe('bsd');
    first.app.componentWillUnmount();
    vi.unstubAllGlobals();
    // Cancel opens the app again in the same page with the old session (ndt) and the same address: it stays in ndt and
    // corrects the address.
    const again = await apiAt('/controls?ms=isms&org=bsd');
    await vi.waitFor(() => expect(again.app._nav).toBeNull());
    expect(again.env.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect([again.app.state.org, again.app.state.screen]).toEqual(['ndt', 'controls']);
    expect(again.tab.ops).toEqual(['replace /controls?ms=isms&org=ndt']);
    expect(orgTried()).toBeNull();
  });

  it('the organisation menu writes the new organisation before a switch that asks for a new sign-in', async () => {
    const { app, tab } = await apiAt('/controls?ms=isms&org=ndt');
    await vi.waitFor(() => expect(app._nav).toBeNull());
    app.setOrg('bsd');
    await vi.waitFor(() => expect(orgTried()).toBe('bsd'));
    expect(tab.ops).toEqual(['push /?org=bsd']);
    expect(app.state.org).toBe('ndt');
  });

  it('without a browser the controller keeps the landing of C.3', async () => {
    const fx = await wireOf();
    const env = sourceWith(readRoutes(fx, meOf()));
    const app = mount({ dataSource: env.ds });
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    expect(app._nav).toBeNull();
    expect(app.state.screen).toBe('portfolio');
  });
});

describe('the sample source without a browser', () => {
  it('loads the first organisation as before', async () => {
    const app = mount({ dataSource: createSampleDataSource() });
    app.firstLoad();
    await vi.waitFor(() => expect(app.state.D).toBeTruthy());
    expect([app.state.org, app.state.screen]).toEqual(['ndt', 'portfolio']);
  });
});
