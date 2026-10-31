// Screen addresses (MILESTONE-2 M2-20): reading and writing the address of a screen in the API build (paths) and the
// sample build (hash), the history rule, the tab choice of host screens, the memory of a tried organisation switch,
// and the reserved paths no screen id may take (sign-in pages, the api, the static files NGINX serves).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_PATHS } from '../../src/auth/routes';
import {
  EMPTY_ROUTE, forgetOrgTried, historyStep, isStartQuery, locationUrl, orgTried, parseRoute, rememberOrgTried, routeUrl, sameRoute,
  screenOfPath, screenTabOf, tabChoice, tidyScreenPath, withScreenTab,
} from '../../src/routing';
import type { LocationParts, Route } from '../../src/routing';
import { HOST_SCREENS } from '../../src/screens/registry';
import type { HostContext } from '../../src/screens/types';
import { BUILTIN_SCREEN_IDS } from '../../src/screens/types';

const at = (url: string): LocationParts => {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};
const route = (over: Partial<Route>): Route => ({ ...EMPTY_ROUTE, ...over });

describe('reading an address', () => {
  it('API build: the screen is the path, ms, org and tab are query values', () => {
    expect(parseRoute(at('/controls?ms=isms'), 'path')).toEqual(route({ screen: 'controls', ms: 'isms' }));
    expect(parseRoute(at('/ops?tab=orgs'), 'path')).toEqual(route({ screen: 'ops', tab: 'orgs' }));
    expect(parseRoute(at('/findings/?ms=qms&org=bsd&tab=actions&lang=id'), 'path')).toEqual(route({ screen: 'findings', ms: 'qms', org: 'bsd', tab: 'actions' }));
    expect(parseRoute(at('/'), 'path')).toEqual(EMPTY_ROUTE);
    // The persona is a sample value; the API build ignores it.
    expect(parseRoute(at('/controls?persona=owner'), 'path').persona).toBeNull();
  });

  it('values that are not well formed read as not named', () => {
    expect(parseRoute(at('/Controls?ms=ISMS&org=-x&tab=%20'), 'path')).toEqual(EMPTY_ROUTE);
    expect(parseRoute(at('/admin/license'), 'path').screen).toBeNull();
    expect(parseRoute(at('/%E0%A4%A'), 'path').screen).toBeNull();
    expect(screenOfPath('//evil.example')).toBeNull();
    expect(screenOfPath('/a.b')).toBeNull();
    expect(screenOfPath('/x/')).toBe('x');
  });

  it('an application path with a folder part is tidied before anything renders; the sign-in pages are left alone', () => {
    // A screen path with a trailing slash keeps its screen.
    expect(tidyScreenPath('/controls/')).toBe('/controls');
    expect(tidyScreenPath('/controls//')).toBe('/controls');
    expect(tidyScreenPath('//controls')).toBe('/controls');
    // Any other path with a folder part names no screen: it opens the start screen, so it becomes the root.
    expect(tidyScreenPath('/controls/x')).toBe('/');
    expect(tidyScreenPath('/a/b/')).toBe('/');
    expect(tidyScreenPath('/Controls/')).toBe('/');
    expect(tidyScreenPath('/a.png/')).toBe('/');
    expect(tidyScreenPath('//')).toBe('/');
    // Paths at the site root are left as they are.
    expect(tidyScreenPath('/controls')).toBeNull();
    expect(tidyScreenPath('/nothing')).toBeNull();
    expect(tidyScreenPath('/')).toBeNull();
    expect(tidyScreenPath('')).toBeNull();
    // The sign-in pages belong to the boot router.
    expect(tidyScreenPath('/login/mfa')).toBeNull();
    expect(tidyScreenPath('/login/mfa/')).toBeNull();
    expect(tidyScreenPath('/login/enrol')).toBeNull();
    expect(tidyScreenPath('/login/')).toBeNull();
  });

  it('sample build: the address is in the hash, the start query of C.2 still works', () => {
    expect(parseRoute(at('/#/controls?ms=qms&org=bsd&persona=owner'), 'hash')).toEqual(route({ screen: 'controls', ms: 'qms', org: 'bsd', persona: 'owner' }));
    expect(parseRoute(at('/index.html?lang=id#/docs'), 'hash')).toEqual(route({ screen: 'docs' }));
    expect(parseRoute(at('/#/'), 'hash')).toEqual(EMPTY_ROUTE);
    expect(parseRoute(at('/?screen=license&persona=top'), 'hash')).toEqual(route({ screen: 'license', persona: 'top' }));
    expect(parseRoute(at('/?screen=license&persona=ceo'), 'hash')).toEqual(route({ screen: 'license' }));
    // The hash wins over the start query.
    expect(parseRoute(at('/?screen=license#/fw'), 'hash').screen).toBe('fw');
    expect(isStartQuery(at('/?screen=license'))).toBe(true);
    expect(isStartQuery(at('/?persona=owner'))).toBe(true);
    expect(isStartQuery(at('/?screen=license#/fw'))).toBe(false);
    expect(isStartQuery(at('/?lang=id'))).toBe(false);
    // An anchor that is not an address is not read.
    expect(parseRoute(at('/#top'), 'hash')).toEqual(EMPTY_ROUTE);
  });
});

describe('writing an address', () => {
  it('API build: path and route values first, the other values kept in their order, no fragment', () => {
    const loc = at('/portfolio?lang=id&ms=qms&theme=dark&screen=x#token');
    expect(routeUrl(loc, 'path', route({ screen: 'controls', ms: 'isms', org: 'ndt' }))).toBe('/controls?ms=isms&org=ndt&lang=id&theme=dark');
    expect(routeUrl(at('/'), 'path', route({ screen: 'ops', tab: 'orgs', persona: 'owner' }))).toBe('/ops?tab=orgs');
    expect(routeUrl(at('/x'), 'path', EMPTY_ROUTE)).toBe('/');
  });

  it('sample build: the path and the other query values stay, the route goes in the hash', () => {
    const loc = at('/index.html?lang=id&screen=license&persona=top#/old');
    expect(routeUrl(loc, 'hash', route({ screen: 'license', ms: 'isms', org: 'ndt', persona: 'top' }))).toBe('/index.html?lang=id#/license?ms=isms&org=ndt&persona=top');
    expect(routeUrl(at('/'), 'hash', route({ screen: 'portfolio' }))).toBe('/#/portfolio');
    expect(routeUrl(at('/'), 'hash', route({ org: 'bsd' }))).toBe('/#/?org=bsd');
  });

  it('reading what was written gives the same route', () => {
    const r = route({ screen: 'findings', ms: 'qms', org: 'bsd', tab: 'actions' });
    expect(parseRoute(at(routeUrl(at('/?lang=id'), 'path', r)), 'path')).toEqual(r);
    const s = { ...r, persona: 'auditor' };
    expect(parseRoute(at(routeUrl(at('/?lang=id'), 'hash', s)), 'hash')).toEqual(s);
    expect(locationUrl(at('/a?b=1#c'))).toBe('/a?b=1#c');
  });
});

describe('the history rule', () => {
  it('a new screen or organisation adds an entry; a new system, tab or persona replaces it', () => {
    const a = route({ screen: 'controls', ms: 'isms', org: 'ndt' });
    expect(historyStep(a, { ...a })).toBeNull();
    expect(historyStep(a, { ...a, screen: 'docs' })).toBe('push');
    expect(historyStep(a, { ...a, org: 'bsd' })).toBe('push');
    expect(historyStep(a, { ...a, ms: 'qms' })).toBe('replace');
    expect(historyStep(a, { ...a, tab: 'x' })).toBe('replace');
    expect(historyStep(a, { ...a, persona: 'owner' })).toBe('replace');
    expect(sameRoute(a, { ...a, tab: null })).toBe(true);
  });
});

describe('the tab of a host screen', () => {
  it('shows the named tab when the screen has it, else the fallback, and marks the other as stale', () => {
    expect(tabChoice('actions', ['findings', 'actions'], 'findings')).toEqual({ current: 'actions', stale: false });
    expect(tabChoice(null, ['findings', 'actions'], 'findings')).toEqual({ current: 'findings', stale: false });
    expect(tabChoice('grants', ['packs'], 'packs')).toEqual({ current: 'packs', stale: true });
  });

  it('a context carries the tab access of the controller; one built by hand has none', () => {
    const plain = { lang: 'en' } as unknown as HostContext;
    expect(screenTabOf(plain)).toBeNull();
    const calls: (string | null)[] = [];
    const setTab = (id: string | null) => calls.push(id);
    const ctx = withScreenTab({ lang: 'en' } as unknown as HostContext, { tab: 'orgs', setTab });
    expect(screenTabOf(ctx)).toEqual({ tab: 'orgs', setTab });
    screenTabOf(ctx)!.setTab(null);
    expect(calls).toEqual([null]);
  });
});

describe('the memory of a tried organisation switch', () => {
  it('remembers, reads and forgets the slug', () => {
    forgetOrgTried();
    expect(orgTried()).toBeNull();
    rememberOrgTried('bsd');
    expect(orgTried()).toBe('bsd');
    rememberOrgTried('rmn');
    expect(orgTried()).toBe('rmn');
    forgetOrgTried();
    expect(orgTried()).toBeNull();
  });

  it('lives in the page only: nothing is written to the browser storage, and a new page starts without it', async () => {
    const writes: string[] = [];
    const store = { getItem: () => null, setItem: (k: string) => void writes.push(k), removeItem: (k: string) => void writes.push(k) };
    vi.stubGlobal('sessionStorage', store);
    vi.stubGlobal('localStorage', store);
    try {
      rememberOrgTried('bsd');
      expect(writes).toEqual([]);
      // A new page loads the module again: a typed or pasted address, a reload, a return from another site.
      vi.resetModules();
      const fresh = await import('../../src/routing/memory');
      expect(fresh.orgTried()).toBeNull();
      expect(orgTried()).toBe('bsd');
    } finally {
      forgetOrgTried();
      vi.unstubAllGlobals();
    }
  });
});

describe('reserved paths', () => {
  const ids = [...BUILTIN_SCREEN_IDS, ...HOST_SCREENS.map((d) => d.id)];
  it('no screen id is a sign-in page, the api, the static files or the health check', () => {
    const reserved = new Set(['api', 'assets', 'healthz', 'index.html', ...Object.values(AUTH_PATHS).map((p) => p.split('/')[1])]);
    expect(ids.filter((id) => reserved.has(id))).toEqual([]);
  });

  it('every screen id reads back from its address in both builds', () => {
    for (const id of ids) {
      expect(parseRoute(at(routeUrl(at('/'), 'path', route({ screen: id }))), 'path').screen, id).toBe(id);
      expect(parseRoute(at(routeUrl(at('/'), 'hash', route({ screen: id }))), 'hash').screen, id).toBe(id);
    }
  });

  it('NGINX serves the app shell for every path without a file extension', () => {
    const conf = readFileSync(fileURLToPath(new URL('../../../../deploy/nginx/site.conf', import.meta.url)), 'utf8');
    expect(conf).toMatch(/location \/ \{[^}]*try_files \$uri \$uri\/ \/index\.html;/);
    // Only paths with a file extension get a real 404: a screen id has none (registry.ts).
    expect(conf).toMatch(/location ~ "\\\.\[A-Za-z0-9\]\{1,8\}\$"/);
    expect(ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id))).toBe(true);
  });
});
