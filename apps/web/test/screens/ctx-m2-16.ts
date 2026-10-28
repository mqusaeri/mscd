// Test doubles of the M2-16 screen tests: a host context in sample or API mode over the sample snapshot, and a
// renderer that wraps a node in the host context and the theme root, as the controller does.
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, HostPerm, Lang } from '../../src/screens/types';
import type { ControllerData, MeView } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';

const perms = (perm: HostPerm) => (Array.isArray(perm) ? perm : [perm as string]);

let cached: ControllerData | null = null;

/** The sample snapshot of PT Nusantara Digital Teknologi with the date helpers, as the controller's D. */
export async function loadSampleD(): Promise<ControllerData> {
  if (cached) return cached;
  const snap = (await createSampleDataSource().load()) as Record<string, unknown>;
  cached = { ...snap, ...makeDates(String(snap.today ?? SAMPLE.TODAY_S)) } as unknown as ControllerData;
  return cached;
}

/** The snapshot loaded by `loadSampleD` (call that in `beforeAll` first). */
export function sampleD(): ControllerData {
  if (!cached) throw new Error('call loadSampleD() in beforeAll first');
  return cached;
}

export interface CtxOptions {
  lang?: Lang;
  theme?: 'light' | 'dark';
  mode?: 'sample' | 'api';
  /** API mode: organisation and platform permissions. */
  org?: string[];
  /** API mode: permissions per system. */
  ms?: Record<string, string[]>;
  me?: Partial<MeView> | null;
  D?: ControllerData | null;
  over?: Partial<HostContext>;
}

/** A host context; in sample mode the manager persona holds everything, in API mode the given permissions. */
export function ctxOf(options: CtxOptions = {}): HostContext {
  const lang = options.lang ?? 'en';
  const mode = options.mode ?? 'sample';
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  const D = options.D === undefined ? sampleD() : options.D;
  const orgPerms = options.org ?? [];
  const msPerms = options.ms ?? {};
  const ms = D?.MS?.[0] ?? null;
  const ctx = {
    lang,
    li,
    fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (m: string, k: string) => (k in v ? String(v[k]) : m)),
    theme: options.theme ?? 'light',
    D,
    msObj: ms,
    org: D?.orgs?.[0] ?? null,
    me: options.me === undefined ? null : (options.me as MeView | null),
    person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
    role: 'manager',
    mode,
    client: null,
    ds: null,
    screen: 'portfolio',
    params: {},
    can: (m: string | null | undefined, perm: HostPerm) => (mode === 'sample' ? Boolean(m) : Boolean(m) && perms(perm).some((p) => (msPerms[m as string] ?? []).includes(p))),
    orgCan: (perm: HostPerm) => (mode === 'sample' ? true : perms(perm).some((p) => orgPerms.includes(p))),
    platformCan: (perm: HostPerm) => (mode === 'sample' ? true : perms(perm).some((p) => orgPerms.includes(p))),
    toast: vi.fn(),
    go: vi.fn(),
    track: <T,>(p: Promise<T>) => p,
    reload: vi.fn(async () => undefined),
    command: vi.fn(),
    openPicker: async () => null,
    layer: () => null,
    ...options.over,
  };
  return ctx as unknown as HostContext;
}

/** Static markup of a node inside the host context and a theme root. */
export function render(node: ReactNode, ctx: HostContext, theme: 'light' | 'dark' = 'light'): string {
  return renderToStaticMarkup(createElement(HostCtx.Provider, { value: ctx }, createElement('div', { className: 'mscd', 'data-theme': theme }, node)));
}

/** The pair in a language. */
export const t = (pair: readonly [string, string], lang: Lang = 'en'): string => pair[lang === 'id' ? 1 : 0];

/** HTML-escaped text as React writes it into markup. */
export const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** Every pair of a text table differs between the languages, except `same`, and has no em dash or centre dot. */
export function textProblems(table: Record<string, readonly [string, string]>, same: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const [key, pair] of Object.entries(table)) {
    if (!pair[0].trim() || !pair[1].trim()) out.push(`${key}: empty`);
    if (pair[0] === pair[1] && !same.includes(key)) out.push(`${key}: Indonesian equals English`);
    if (/[—·]/.test(pair.join(' '))) out.push(`${key}: em dash or centre dot`);
  }
  return out;
}
