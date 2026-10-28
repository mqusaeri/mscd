// Fixtures of the M2-11 unit tests (controls-edit, evidence-edit, phases-edit): the sample snapshot as the controller
// holds it (`this.D`), a host context over it, an API snapshot with refs, and markup rendering in a theme.
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { makeDates } from '../../src/data/dates.js';
import type { ControllerData, DataSource, Snapshot } from '../../src/data/types';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';

export const FORBIDDEN = /[—·]/;

/** The sample data source and its first snapshot as controller data (with the date helpers). */
export async function sampleWorld(): Promise<{ ds: DataSource; D: ControllerData; snap: Snapshot }> {
  const ds = createSampleDataSource() as unknown as DataSource;
  const snap = await ds.load();
  return { ds, snap, D: asD(snap) };
}

export function asD(snap: Snapshot): ControllerData {
  return { ...snap, T: {}, TERA: {}, INTEG: {}, ...makeDates(snap.today) } as unknown as ControllerData;
}

/** A host context over controller data; `can` and the rest come from `over`. */
export function ctxOf(D: ControllerData, lang: Lang = 'en', over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? String(t[lang === 'id' ? 1 : 0]) : String(t ?? ''));
  const ms = D.MS.find((m) => m.id === 'isms') ?? D.MS[0];
  return {
    lang,
    li,
    fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (m: string, k: string) => (k in v ? String(v[k]) : m)),
    theme: 'light', D, msObj: ms, org: { id: 'ndt', name: 'Org', ms: [], deploy: 'saas', sites: 1 }, me: null,
    person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }, role: 'manager', mode: 'sample',
    client: null, ds: null, screen: 'controls', params: {},
    can: () => true, orgCan: () => true, platformCan: () => false,
    toast: vi.fn(), go: vi.fn(), track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(),
    openPicker: vi.fn(async () => null), layer: () => null,
    ...over,
  } as unknown as HostContext;
}

/** An API-mode context: permissions and roles of `Me` in `ms`. */
export function apiCtxOf(D: ControllerData, ms: string, perms: string[], roles: string[], lang: Lang = 'en', over: Partial<HostContext> = {}): HostContext {
  return ctxOf(D, lang, {
    mode: 'api',
    role: roles.includes('ms_manager') ? 'manager' : 'owner',
    me: { rolesByMs: { [ms]: roles }, permissions: { org: [], ms: { [ms]: perms } } } as unknown as HostContext['me'],
    can: (m, p) => m === ms && (Array.isArray(p) ? p : [p]).some((x) => perms.includes(x)),
    ...over,
  });
}

/** Static markup of a node inside the host context, in a theme. */
export function render(node: ReactElement, ctx: HostContext, theme: 'light' | 'dark' = 'light'): string {
  return renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);
}

/** Every text pair of a TEXT table: both languages filled, no em dash or centre dot. */
export function pairProblems(table: Record<string, readonly [string, string]>, same: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const [key, [en, id]] of Object.entries(table)) {
    if (!en || !id) out.push(`${key}: empty`);
    if (FORBIDDEN.test(en) || FORBIDDEN.test(id)) out.push(`${key}: forbidden character`);
    if (en === id && !same.includes(key)) out.push(`${key}: Indonesian equals English`);
  }
  return out;
}
