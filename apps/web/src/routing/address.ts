// Screen addresses (MILESTONE-2 M2-20). Every screen of the app has an address: the screen id as the path, and the
// selected management system (`ms`), the organisation of a person who belongs to several (`org`) and the tab of a
// host screen with tabs (`tab`) as query values, for example `/controls?ms=isms` or `/ops?tab=orgs`.
//
// - The API build uses paths (`/controls?ms=isms`). NGINX serves index.html for every path without a file extension
//   (deploy/nginx/site.conf), and `vite preview` does the same, so a refresh or a copied address reaches the app.
// - The sample build keeps working from files, so it keeps the path of index.html and puts the address in the hash:
//   `index.html#/controls?ms=isms&org=ndt`. Its persona travels as `persona=<role>` when it is not the manager.
//   The start query of the sample build (`?screen=<id>&persona=<role>`, MILESTONE-2 C.2) still opens a screen.
// - The other query values of the address (the display settings `lang`, `theme`, `density` and the rest) stay as
//   they are.
//
// Pure functions without React or a browser, so the unit tests run them with plain objects.
import { authPageOf } from '../auth/routes';

/** `path`: the API build (`/controls?ms=isms`); `hash`: the sample build (`#/controls?ms=isms`). */
export type AddressMode = 'path' | 'hash';

/** Where the app is: the values an address carries. Null means "not named in the address". */
export interface Route {
  /** Screen id (built-in or host screen). */
  screen: string | null;
  /** Slug of the selected management system. */
  ms: string | null;
  /** Slug of the organisation; only in the address of a person who belongs to several organisations. */
  org: string | null;
  /** Tab of a host screen with tabs. */
  tab: string | null;
  /** Sample persona other than the manager (sample build only). */
  persona: string | null;
}

/** The parts of a browser location the functions read. */
export interface LocationParts {
  pathname: string;
  search: string;
  hash: string;
}

/** Query values that belong to the address of a screen, in the order they are written. */
export const ROUTE_KEYS = ['ms', 'org', 'tab', 'persona'] as const;
type RouteKey = (typeof ROUTE_KEYS)[number];

/** Query values of the sample build's start query (C.2); read once at start and then removed from the address. */
const START_KEYS = ['screen', 'persona'] as const;

/** The sample personas (`UI_ROLES`). */
export const PERSONAS = ['manager', 'owner', 'auditor', 'top'] as const;

/** Screen ids (registry.ts: lower case letters, digits and hyphens). */
const SCREEN_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Management system slugs (`MsId` of the contract). */
const MS_SLUG = /^[a-z][a-z0-9-]{1,19}$/;
/** Organisation slugs (`OrgSlug` of the contract). */
const ORG_SLUG = /^[a-z][a-z0-9_]{1,39}$/;
/** Tab ids of host screens. */
const TAB_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export const EMPTY_ROUTE: Route = Object.freeze({ screen: null, ms: null, org: null, tab: null, persona: null });

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function valid(value: string | null | undefined, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** The screen id of a path: one segment (`/controls`, a trailing slash is ignored); null for `/` and anything else. */
export function screenOfPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  return valid(decode(parts[0]), SCREEN_ID);
}

/**
 * The path an application address is written with before anything renders, or null when it needs no change. The
 * generated views load some images with a relative path (the sidebar logo `assets/cyberlentera-logo.png`), which
 * resolves from the site root only when the path has no folder part. So a screen path with a trailing slash
 * (`/controls/`) becomes `/controls`, and any other path with a folder part (`/controls/x`, `/a/b/`) names no screen
 * and becomes `/`, which opens the start screen as that path would. The sign-in pages keep their paths: they belong
 * to the boot router. The API build writes the tidy path before the boot router starts (main.jsx).
 */
export function tidyScreenPath(pathname: string): string | null {
  if (pathname.indexOf('/', 1) === -1 || authPageOf(pathname)) return null;
  const screen = screenOfPath(pathname);
  return screen ? `/${screen}` : '/';
}

function fromQuery(query: URLSearchParams, screen: string | null): Route {
  const persona = query.get('persona');
  return {
    screen,
    ms: valid(query.get('ms'), MS_SLUG),
    org: valid(query.get('org'), ORG_SLUG),
    tab: valid(query.get('tab'), TAB_ID),
    persona: persona && (PERSONAS as readonly string[]).includes(persona) ? persona : null,
  };
}

/** The address of the sample build in the hash (`#/controls?ms=isms`), or null when the hash holds none. */
function hashRoute(hash: string): Route | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text.startsWith('/')) return null;
  const at = text.indexOf('?');
  const path = at < 0 ? text : text.slice(0, at);
  const query = new URLSearchParams(at < 0 ? '' : text.slice(at + 1));
  return fromQuery(query, path === '/' ? null : screenOfPath(path));
}

/**
 * The route an address names. A value that is not well formed reads as not named (the app then corrects the
 * address). Path mode reads the path and the query; hash mode reads the hash, else the start query of the sample
 * build (`?screen=<id>&persona=<role>`).
 */
export function parseRoute(location: LocationParts, mode: AddressMode): Route {
  if (mode === 'path') {
    const query = new URLSearchParams(location.search);
    return { ...fromQuery(query, screenOfPath(location.pathname)), persona: null };
  }
  const inHash = hashRoute(location.hash);
  if (inHash) return inHash;
  const query = new URLSearchParams(location.search);
  const persona = query.get('persona');
  return {
    ...EMPTY_ROUTE,
    screen: valid(query.get('screen'), SCREEN_ID),
    persona: persona && (PERSONAS as readonly string[]).includes(persona) ? persona : null,
  };
}

/** True when the address of the sample build was given as the start query (`?screen=` or `?persona=`), not a hash. */
export function isStartQuery(location: LocationParts): boolean {
  if (hashRoute(location.hash)) return false;
  const query = new URLSearchParams(location.search);
  return START_KEYS.some((k) => query.has(k));
}

/** The route values as query text in the fixed order of ROUTE_KEYS ('' when none is set). */
function routeQuery(route: Route, mode: AddressMode): string {
  const out = new URLSearchParams();
  for (const key of ROUTE_KEYS) {
    if (key === 'persona' && mode === 'path') continue;
    const value = route[key as RouteKey];
    if (value) out.set(key, value);
  }
  return out.toString();
}

/** The query of the location without the route values and the start query, kept in its order. */
function otherQuery(search: string): string {
  const query = new URLSearchParams(search);
  for (const key of [...ROUTE_KEYS, ...START_KEYS]) query.delete(key);
  return query.toString();
}

/**
 * The address of a route, built on the current location: path mode writes `/<screen>?<route values>&<other values>`;
 * hash mode keeps the path and the other query values and writes `#/<screen>?<route values>`. A route without a
 * screen gives `/` (path) or `#/` (hash).
 */
export function routeUrl(location: LocationParts, mode: AddressMode, route: Route): string {
  const screen = route.screen ? `/${route.screen}` : '/';
  const own = routeQuery(route, mode);
  const other = otherQuery(location.search);
  if (mode === 'path') {
    const query = [own, other].filter(Boolean).join('&');
    return screen + (query ? `?${query}` : '');
  }
  return location.pathname + (other ? `?${other}` : '') + '#' + screen + (own ? `?${own}` : '');
}

/** The current address as one string (path, query and hash). */
export function locationUrl(location: LocationParts): string {
  return location.pathname + location.search + location.hash;
}

/** True when both routes name the same place. */
export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.ms === b.ms && a.org === b.org && a.tab === b.tab && a.persona === b.persona;
}

/**
 * How a change of place enters the browser history: a new screen or organisation adds an entry (`push`), a new
 * system, tab or persona on the same screen replaces the current one (`replace`), the same place needs nothing.
 */
export function historyStep(from: Route, to: Route): 'push' | 'replace' | null {
  if (sameRoute(from, to)) return null;
  return from.screen !== to.screen || from.org !== to.org ? 'push' : 'replace';
}
