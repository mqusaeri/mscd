// The illustration library (MILESTONE-2 MOT-03, section L): every scene in both languages and themes, its text
// alternative, sizes, the entrance budget of every animated element, the Getting started progress, the geometry, the
// EmptyState prop of the UI kit, and the rules L-1 to L-5 on the stylesheet and the sources.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRESS, ENTRANCE_MS, Illustration, PATH_STEPS, SCENES, SCENE_TEXT, SIZES, STAGE, isSceneName, sceneLabel, widthOf,
} from '../../src/illustrations';
import type { SceneName } from '../../src/illustrations';
import { cubicAt, litSteps, pathOf, rosette, smoothSegments } from '../../src/illustrations/geometry';
import { SCENE_DRAWINGS, pathTiming } from '../../src/illustrations/scenes';
import { EmptyState, HostCtx, textOf } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '../../src/illustrations');
const CSS = readFileSync(path.join(LIB, 'illustrations.css'), 'utf8');
const STYLES = readFileSync(path.resolve(HERE, '../../src/styles.css'), 'utf8');
const SOURCES = readdirSync(LIB).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [f, readFileSync(path.join(LIB, f), 'utf8')] as const);
const FORBIDDEN = /[\u2014\u00b7]/;
const LANGS: Lang[] = ['en', 'id'];
const THEMES = ['light', 'dark'] as const;
const ENTRANCE_CLASSES = ['il-fade', 'il-rise', 'il-drop', 'il-pop', 'il-draw', 'il-slide', 'il-slide-l', 'il-slide-r'];

/** Renders inside a host context of the language and an .mscd root of the theme, as the app does. */
function render(node: ReactElement, lang: Lang = 'en', theme: 'light' | 'dark' = 'light'): string {
  const ctx = { lang, theme, li: (t: unknown) => textOf(t as string, lang), layer: () => null } as unknown as HostContext;
  return renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);
}

/** The opening tags of every element of a markup string, with their attributes. */
function elements(html: string): { tag: string; attrs: Record<string, string> }[] {
  const out: { tag: string; attrs: Record<string, string> }[] = [];
  for (const m of html.matchAll(/<([a-zA-Z]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    out.push({ tag: m[1], attrs });
  }
  return out;
}

/** The entrance timing of every animated element: [class list, delay ms, duration ms]. */
function timings(html: string): { cls: string[]; delay: number; duration: number }[] {
  return elements(html)
    .filter((e) => /animation-/.test(e.attrs.style ?? ''))
    .map((e) => ({
      cls: (e.attrs.class ?? '').split(/\s+/),
      delay: Number(/animation-delay:(\d+)ms/.exec(e.attrs.style)?.[1]),
      duration: Number(/animation-duration:(\d+)ms/.exec(e.attrs.style)?.[1]),
    }));
}

// Tokens of src/styles.css for each theme, and WCAG contrast.
function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const block = theme === 'light' ? /\.mscd\{(--bg:[^}]*)\}/.exec(STYLES)?.[1] : /\.mscd\[data-theme="dark"\]\{(--acc:[^}]*)\}/.exec(STYLES)?.[1];
  if (!block) throw new Error(`no ${theme} token block in styles.css`);
  const light = theme === 'dark' ? tokens('light') : {};
  return { ...light, ...Object.fromEntries([...block.matchAll(/(--[\w-]+):([^;]+)/g)].map((m) => [m[1], m[2].trim()])) };
}
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('scenes', () => {
  it('are the eight scenes of the brief, each with a drawing and texts', () => {
    expect([...SCENES]).toEqual(['getting-started', 'no-systems', 'no-documents', 'no-evidence', 'no-findings', 'all-done', 'error', 'offline']);
    expect(Object.keys(SCENE_DRAWINGS).sort()).toEqual([...SCENES].sort());
    expect(Object.keys(SCENE_TEXT).sort()).toEqual([...SCENES].sort());
    for (const s of SCENES) expect(isSceneName(s)).toBe(true);
    for (const bad of ['', 'no-docs', 'Error', null, 3, undefined]) expect(isSceneName(bad)).toBe(false);
  });

  for (const scene of SCENES) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        it(`${scene} renders an image with its text alternative in ${lang}, ${theme} theme`, () => {
          const html = render(<Illustration scene={scene} />, lang, theme);
          const svg = elements(html).find((e) => e.tag === 'svg')!;
          expect(svg.attrs.role).toBe('img');
          expect(svg.attrs['aria-label']).toBe(sceneLabel(scene, lang));
          expect(svg.attrs['aria-label']).toBe(textOf(SCENE_TEXT[scene].alt, lang).replace('{done}', '3').replace('{steps}', '5'));
          expect(svg.attrs['data-scene']).toBe(scene);
          expect(svg.attrs.viewBox).toBe(`0 0 ${STAGE.width} ${STAGE.height}`);
          expect([svg.attrs.width, svg.attrs.height]).toEqual(['192', '128']);
          expect(svg.attrs.focusable).toBe('false');
          expect(svg.attrs.class).toBe('il');
          expect(html).toContain(`data-theme="${theme}"`);
          // No text in the pictures (12px rule), no media and no link to anywhere (L-1).
          expect(html).not.toMatch(/<(text|tspan|image|foreignObject|use|a)\b/);
          expect(html).not.toMatch(/https?:|href=/);
        });
      }
    }

    it(`${scene}: every reference points at a definition of the same instance, and two instances share no id`, () => {
      const html = render(<><Illustration scene={scene} /><Illustration scene={scene} /></>);
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const ref of html.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1]);
      const [first, second] = html.split('</svg>');
      const idsOf = (part: string) => [...part.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      for (const ref of first.matchAll(/url\(#([^)]+)\)/g)) expect(idsOf(first)).toContain(ref[1]);
      for (const ref of second.matchAll(/url\(#([^)]+)\)/g)) expect(idsOf(second)).toContain(ref[1]);
    });

    it(`${scene}: every entrance step ends within ${ENTRANCE_MS} ms and every moving element has its timing`, () => {
      const html = render(<Illustration scene={scene} />);
      const steps = timings(html);
      expect(steps.length).toBeGreaterThan(3);
      for (const step of steps) {
        expect(step.cls.some((c) => ENTRANCE_CLASSES.includes(c)), step.cls.join(' ')).toBe(true);
        expect(step.delay).toBeGreaterThanOrEqual(0);
        expect(step.duration).toBeGreaterThanOrEqual(200);
        expect(step.delay + step.duration, step.cls.join(' ')).toBeLessThanOrEqual(ENTRANCE_MS);
      }
      // An element with an entrance class always carries its own timing.
      for (const e of elements(html)) {
        const cls = (e.attrs.class ?? '').split(/\s+/);
        if (cls.some((c) => ENTRANCE_CLASSES.includes(c))) expect(e.attrs.style ?? '', `${e.tag}.${cls.join('.')}`).toMatch(/animation-duration:\d+ms/);
      }
      // A drawn line knows its length (pathLength 1), so the dash offset of the draw runs from 1 to 0.
      for (const e of elements(html).filter((x) => (x.attrs.class ?? '').split(/\s+/).includes('il-draw'))) expect(e.attrs.pathLength).toBe('1');
    });

    it(`${scene}: the moving groups carry no transform of their own (the entrance animates transform)`, () => {
      for (const e of elements(render(<Illustration scene={scene} />))) {
        const cls = (e.attrs.class ?? '').split(/\s+/);
        if (cls.some((c) => ENTRANCE_CLASSES.includes(c))) expect(e.attrs.transform, `${e.tag}.${cls.join('.')}`).toBeUndefined();
      }
    });
  }

  it('the texts have both languages, an Indonesian that differs, and no em dash or centre dot', () => {
    for (const scene of SCENES) {
      for (const [field, pair] of Object.entries(SCENE_TEXT[scene])) {
        expect(pair, `${scene} ${field}`).toHaveLength(2);
        expect(pair[0].trim() && pair[1].trim(), `${scene} ${field}`).toBeTruthy();
        expect(pair[1], `${scene} ${field}`).not.toBe(pair[0]);
        expect(pair.join(' '), `${scene} ${field}`).not.toMatch(FORBIDDEN);
      }
    }
  });
});

describe('the Illustration props', () => {
  it('sizes: sm, md (default), lg and a width in pixels, clamped to 48 to 640, with the 3 by 2 stage', () => {
    expect(SIZES).toEqual({ sm: 128, md: 192, lg: 288 });
    expect([widthOf('sm'), widthOf('md'), widthOf('lg'), widthOf(undefined), widthOf(240), widthOf(10), widthOf(5000), widthOf(Number.NaN)]).toEqual([128, 192, 288, 192, 240, 48, 640, 192]);
    expect(widthOf('xl' as never)).toBe(192);
    for (const [size, w, h] of [['sm', 128, 85], ['lg', 288, 192], [300, 300, 200]] as const) {
      const svg = elements(render(<Illustration scene="no-findings" size={size} />)).find((e) => e.tag === 'svg')!;
      expect([svg.attrs.width, svg.attrs.height]).toEqual([String(w), String(h)]);
    }
  });

  it('decorative hides the picture from assistive technology', () => {
    const svg = elements(render(<Illustration scene="all-done" decorative />)).find((e) => e.tag === 'svg')!;
    expect(svg.attrs['aria-hidden']).toBe('true');
    expect(svg.attrs.role).toBeUndefined();
    expect(svg.attrs['aria-label']).toBeUndefined();
  });

  it('a label of its own replaces the text alternative, in the host language; a blank label keeps the scene text', () => {
    const own = (html: string) => elements(html).find((e) => e.tag === 'svg')!.attrs['aria-label'];
    expect(own(render(<Illustration scene="error" label={['The licence could not be loaded', 'Lisensi tidak dapat dimuat']} />, 'id'))).toBe('Lisensi tidak dapat dimuat');
    expect(own(render(<Illustration scene="error" label="Plain text" />))).toBe('Plain text');
    expect(own(render(<Illustration scene="error" label="  " />))).toBe(sceneLabel('error', 'en'));
    // An explicit language wins over the host language.
    expect(own(render(<Illustration scene="offline" lang="en" />, 'id'))).toBe(textOf(SCENE_TEXT.offline.alt, 'en'));
    // Outside a host screen the language is English.
    expect(own(renderToStaticMarkup(<Illustration scene="offline" />))).toBe(textOf(SCENE_TEXT.offline.alt, 'en'));
  });

  it('still shows the final frame without the entrance; a name that is not a scene renders nothing', () => {
    expect(elements(render(<Illustration scene="no-systems" still />)).find((e) => e.tag === 'svg')!.attrs.class).toBe('il il-still');
    expect(elements(render(<Illustration scene="no-systems" className="mine" />)).find((e) => e.tag === 'svg')!.attrs.class).toBe('il mine');
    expect(renderToStaticMarkup(<Illustration scene={'no-such-scene' as SceneName} />)).toBe('');
  });
});

describe('Getting started progress', () => {
  it('lights one step for any progress and the last step only when everything is done', () => {
    const table: [number, number][] = [[0, 0], [0.01, 1], [0.2, 1], [0.21, 2], [0.4, 2], [0.5, 3], [DEFAULT_PROGRESS, 3], [0.8, 4], [0.99, 4], [1, 5], [7, 5], [-1, 0], [Number.NaN, 0]];
    for (const [p, lit] of table) expect(litSteps(p, PATH_STEPS), String(p)).toBe(lit);
  });

  for (let lit = 0; lit <= PATH_STEPS; lit += 1) {
    it(`${lit} of ${PATH_STEPS} steps: lit steps, the next step marked, the flag only at the end, within the budget`, () => {
      const progress = lit / PATH_STEPS;
      const html = render(<Illustration scene="getting-started" progress={progress} />, 'id');
      expect(html.match(/data-step="lit"/g)?.length ?? 0).toBe(lit);
      expect(html.match(/data-step="current"/g)?.length ?? 0).toBe(lit < PATH_STEPS ? 1 : 0);
      expect(elements(html).find((e) => e.tag === 'svg')!.attrs['aria-label']).toBe(`Jalur langkah yang naik menuju bendera. ${lit} dari 5 langkah menyala.`);
      const timing = pathTiming(lit);
      expect(timing.steps).toHaveLength(lit);
      expect(timing.flag === null).toBe(lit < PATH_STEPS);
      expect(timing.thread === null).toBe(lit === 0);
      // Steps light in order, as the thread reaches them.
      expect([...timing.steps].sort((a, b) => a - b)).toEqual(timing.steps);
      for (const step of timings(html)) expect(step.delay + step.duration).toBeLessThanOrEqual(ENTRANCE_MS);
    });
  }
});

describe('geometry', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: -5 }, { x: 30, y: 0 }];

  it('a smooth path runs through every point, and its first k segments end at point k', () => {
    const segs = smoothSegments(points);
    expect(segs).toHaveLength(3);
    segs.forEach((s, i) => {
      expect(cubicAt(s, 0)).toEqual(points[i]);
      const end = cubicAt(s, 1);
      expect(end.x).toBeCloseTo(points[i + 1].x, 10);
      expect(end.y).toBeCloseTo(points[i + 1].y, 10);
    });
    expect(pathOf(segs.slice(0, 2))).toBe('M0 0 C1.67 0.83 6.67 5.83 10 5 C13.33 4.17 16.67 -4.17 20 -5');
    expect(pathOf([])).toBe('');
    expect(smoothSegments([points[0]])).toEqual([]);
  });

  it('the seal outline is closed with a tip and a notch per point', () => {
    const d = rosette(0, 0, 20, 17, 12);
    expect(d.startsWith('M0 -20 L')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(d.split(' L')).toHaveLength(24);
  });
});

describe('in the EmptyState of the UI kit', () => {
  for (const lang of LANGS) {
    it(`sits in .mx-empty-art above the title and text, in ${lang}`, () => {
      const html = render(
        <EmptyState title={['No documents yet', 'Belum ada dokumen']} text={['Add one', 'Tambahkan satu']} illustration={<Illustration scene="no-documents" />} />,
        lang,
      );
      expect(html).toMatch(/<div class="mx-empty"><div class="mx-empty-art"><svg class="il"/);
      expect(html).toContain(`aria-label="${sceneLabel('no-documents', lang)}"`);
      expect(html.indexOf('mx-empty-art')).toBeLessThan(html.indexOf('mx-empty-title'));
    });
  }
});

describe('section L rules on the stylesheet and the sources', () => {
  it('L-1: nothing is loaded from anywhere; L-2: no loop, reduced motion and still show the final frame', () => {
    expect(CSS).not.toMatch(/url\(|@import|https?:/);
    expect(CSS).not.toMatch(/infinite|alternate/);
    expect(CSS).toMatch(/animation-iteration-count:1/);
    expect(CSS).toMatch(/animation-fill-mode:backwards/);
    expect(CSS).not.toMatch(/animation-fill-mode:(both|forwards)/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.il \*\{animation:none!important\}\}/);
    expect(CSS).toMatch(/\.il\.il-still \*\{animation:none!important\}/);
    // The keyframes only say where an element starts: the end is its resting style, so the rest frame is complete.
    for (const m of CSS.matchAll(/@keyframes (il-[\w-]+)\{(.*?)\}\}/g)) {
      if (m[1] === 'il-draw') expect(m[2]).toMatch(/to\{stroke-dasharray:1 1;stroke-dashoffset:0/);
      else expect(m[2], m[1]).toMatch(/^from\{[^}]*$/);
    }
    // A line that waits for its draw shows nothing: its dash ends before the start of the path and the next dash
    // starts after its end (1 < offset < gap), so no zero-length dash leaves a round cap dot on the path.
    const draw = /@keyframes il-draw\{from\{stroke-dasharray:1 ([\d.]+);stroke-dashoffset:([\d.]+)\}/.exec(CSS);
    expect(draw, 'the waiting state of il-draw').not.toBeNull();
    const [gap, offset] = [Number(draw?.[1]), Number(draw?.[2])];
    expect(offset).toBeGreaterThan(1);
    expect(gap).toBeGreaterThan(offset);
    // Every entrance class has its keyframes.
    for (const c of ENTRANCE_CLASSES) {
      expect(CSS).toContain(`.il .${c}{animation-name:${c}`);
      expect(CSS).toContain(`@keyframes ${c}{`);
    }
    for (const [file, text] of SOURCES) {
      expect(text, file).not.toMatch(/https?:\/\//);
      expect(text, file).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
    }
  });

  it('L-3 and L-5: colours only from the tokens of styles.css, which exist in both themes, and no text in the pictures', () => {
    const used = new Set([...CSS.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const theme of THEMES) {
      const t = tokens(theme);
      for (const v of used) expect(t[v], `${v} in ${theme}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(CSS).not.toMatch(/font-size|font-family/);
    for (const [file, text] of SOURCES) {
      expect(text, file).not.toMatch(/#[0-9a-f]{6}\b|rgba?\(/i);
      expect(text, file).not.toMatch(FORBIDDEN);
    }
  });

  it('L-3: the lines that carry meaning reach 3:1 on the card in both themes (WCAG 1.4.11)', () => {
    for (const theme of THEMES) {
      const t = tokens(theme);
      for (const line of ['--tx3', '--field', '--acc', '--ok', '--bad', '--warn']) {
        expect(contrast(t[line], t['--sur']), `${line} on --sur, ${theme}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(t['--onacc'], t['--acc']), `tick on the accent, ${theme}`).toBeGreaterThanOrEqual(3);
      for (const [line, fill] of [['--acc', '--accbg'], ['--ok', '--okbg'], ['--bad', '--badbg'], ['--warn', '--warnbg']]) {
        expect(contrast(t[line], t[fill]), `${line} on ${fill}, ${theme}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
