// The illustration gallery (MILESTONE-2 MOT-03): a host screen of the sample build only. Its definition, the inert
// definition of an API build, who may open it in each mode, and the gallery itself in both languages and themes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@mscd/shared';
import { SCENES, SCENE_TEXT, sceneLabel } from '../../src/illustrations';
import { apiCan, apiOrgCan, canOpenHost, sampleCan } from '../../src/screens/host';
import { hostById, validateScreens } from '../../src/screens/registry';
import screen from '../../src/screens/illustrations/index';
import { DEFINITION_TEXT, NotInThisBuild, SAMPLE_ONLY_PERM, galleryScreen } from '../../src/screens/illustrations/definition';
import Gallery, { PROGRESS_STEPS } from '../../src/screens/illustrations/Screen';
import { TEXT } from '../../src/screens/illustrations/text';
import { HostCtx, fillText, textOf } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { UiRole } from '../../src/data/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLDER = path.resolve(HERE, '../../src/screens/illustrations');
const FORBIDDEN = /[\u2014\u00b7]/;
const PERSONAS: UiRole[] = ['manager', 'top', 'auditor', 'owner'];

/** A host context of a mode: sample personas, or an API session that holds every permission of the F.6 matrix. */
function ctxOf(mode: 'sample' | 'api', role: UiRole = 'manager', lang: Lang = 'en'): HostContext {
  const all = { org: [...PERMISSIONS], ms: { isms: [...PERMISSIONS] } };
  return {
    lang,
    li: (t: unknown) => textOf(t as string, lang),
    fill: (t: unknown, v: Record<string, string | number>) => fillText(t as string, v, lang),
    theme: 'light',
    D: null,
    msObj: { id: 'isms' },
    org: null,
    me: null,
    person: { handle: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
    role,
    mode,
    client: null,
    ds: null,
    screen: 'illustrations',
    params: {},
    can: (ms: string, perm: string | string[]) => (mode === 'api' ? apiCan(all, ms, perm) : sampleCan(role, perm)),
    orgCan: (perm: string | string[]) => (mode === 'api' ? apiOrgCan(all, perm) : sampleCan(role, perm)),
    platformCan: (perm: string | string[]) => (mode === 'api' ? apiOrgCan(all, perm) : sampleCan(role, perm)),
    toast: vi.fn(),
    go: vi.fn(),
    track: <T,>(p: Promise<T>) => p,
    reload: async () => undefined,
    command: vi.fn(),
    openPicker: async () => null,
    layer: () => null,
  } as unknown as HostContext;
}

function renderGallery(lang: Lang, theme: 'light' | 'dark'): string {
  const ctx = ctxOf('sample', 'manager', lang);
  return renderToStaticMarkup(
    <HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}><Gallery ctx={ctx} /></div></HostCtx.Provider>,
  );
}

describe('the gallery screen definition', () => {
  it('is a valid host screen without a sidebar entry, registered from its folder', () => {
    expect(validateScreens([screen])).toEqual([]);
    expect(hostById('illustrations')).toBe(screen);
    expect(screen).toMatchObject({ id: 'illustrations', path: '/admin/illustrations', group: 'admin', scope: 'org', nav: false, perm: SAMPLE_ONLY_PERM });
    expect([...screen.roles]).toEqual(PERSONAS);
    expect(screen.pageActions).toBeUndefined();
    expect(screen.label).toEqual([...DEFINITION_TEXT.title]);
    expect(screen.tera?.how.length).toBeGreaterThan(0);
  });

  it('opens for every sample persona and for no API session, even one with every permission of the matrix', () => {
    expect(PERMISSIONS as readonly string[]).not.toContain(SAMPLE_ONLY_PERM);
    for (const role of PERSONAS) expect(canOpenHost('illustrations', ctxOf('sample', role), role), role).toBe(true);
    for (const role of PERSONAS) expect(canOpenHost('illustrations', ctxOf('api', role), role), role).toBe(false);
  });

  it('the sample build loads the gallery lazily; an API build gets a body that renders nothing and holds no gallery code', () => {
    // Vitest builds like the sample build (VITE_DATA_SOURCE is not api): the body is the lazy gallery.
    expect(screen.Component).not.toBe(NotInThisBuild);
    expect((screen.Component as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.lazy'));
    const api = galleryScreen(NotInThisBuild);
    expect(validateScreens([api])).toEqual([]);
    expect(renderToStaticMarkup(<api.Component ctx={ctxOf('api')} />)).toBe('');
    // The build replaces the test, so the API bundle drops the dynamic import (checked on a real build by
    // e2e/illustrations.spec.js). No file of the folder imports the gallery statically.
    const index = readFileSync(path.join(FOLDER, 'index.tsx'), 'utf8');
    expect(index).toContain("import.meta.env.VITE_DATA_SOURCE === 'api' ? NotInThisBuild : lazy(() => import('./Screen'))");
    // The eager part (index.tsx, definition.ts) imports neither the gallery, its texts nor the library.
    for (const file of ['index.tsx', 'definition.ts']) {
      expect(readFileSync(path.join(FOLDER, file), 'utf8'), file).not.toMatch(/(^|\n)\s*(import|export)\s[^;]*?from\s*'(\.\/Screen|\.\/text|\.\.\/\.\.\/illustrations[^']*)'/);
    }
  });

  it('every text has both languages, an Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries({ ...TEXT, ...DEFINITION_TEXT })) {
      expect(pair[0].trim() && pair[1].trim(), key).toBeTruthy();
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(FORBIDDEN);
    }
  });
});

describe('the gallery', () => {
  for (const lang of ['en', 'id'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`shows every scene with its name, use and text alternative, the empty state, progress and sizes in ${lang}, ${theme} theme`, () => {
        const html = renderGallery(lang, theme);
        const pick = (pair: readonly [string, string]) => pair[lang === 'id' ? 1 : 0];
        const other = (pair: readonly [string, string]) => pair[lang === 'id' ? 0 : 1];
        // 8 scene cards, the empty state, 4 progress steps and 3 sizes.
        expect(html.match(/<svg class="il"/g)).toHaveLength(SCENES.length + 1 + PROGRESS_STEPS.length + 3);
        for (const scene of SCENES) {
          expect(html).toContain(`data-scene="${scene}"`);
          expect(html).toContain(`<dd class="mx-mono">${scene}</dd>`);
          expect(html).toContain(pick(SCENE_TEXT[scene].title));
          expect(html).toContain(pick(SCENE_TEXT[scene].use));
          expect(html).toContain(sceneLabel(scene, lang));
        }
        expect(html).toMatch(/<div class="mx-empty"><div class="mx-empty-art"><svg class="il" data-scene="no-documents"/);
        for (const [key, pair] of Object.entries(TEXT)) {
          if (key === 'exampleOnly' || key.startsWith('size') || key === 'progressValue') continue;
          expect(html, key).toContain(pick(pair));
          expect(html, key).not.toContain(other(pair));
        }
        expect(html).toContain(fillText(TEXT.progressValue, { pct: 40, done: 2, steps: 5 }, lang));
        expect(html).toContain(fillText(TEXT.progressValue, { pct: 100, done: 5, steps: 5 }, lang));
        for (const size of [TEXT.sizeSm, TEXT.sizeMd, TEXT.sizeLg]) expect(html).toContain(pick(size));
        expect(html).toMatch(/width="128" height="85"/);
        expect(html).toMatch(/width="288" height="192"/);
        expect(html).not.toMatch(FORBIDDEN);
      });
    }
  }

  it('the gallery stylesheet uses only tokens and no text under 12px', () => {
    const css = readFileSync(path.join(FOLDER, 'gallery.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|url\(|@import/i);
    for (const m of css.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });
});
