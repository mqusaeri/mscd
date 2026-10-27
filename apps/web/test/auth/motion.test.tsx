// The motion of the sign-in brand panel (MILESTONE-2 MOT-02): the scene maths, the engine's lifecycle driven by fake
// browser APIs, the brand panel markup and the stylesheet rules of section L (L-1 to L-5).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEXT, li } from '../../src/auth/i18n';
import { createThreadEngine, ENGINE, GLOW, loomOf, maskAlpha } from '../../src/auth/motion/engine';
import type { Layout, MotionEnv } from '../../src/auth/motion/engine';
import {
  CHAIN_ARC, CHAIN_PATH, CHAIN_POINTS, EVIDENCE, KEEP, LOOM, MOTES, NODE_FRACTIONS, QUIET, SIGNAL, THREAD_COUNT, makeThreads,
  motesAt, nodeGlow, parseCubicPath, pinch, pointAt, quietFactor, sampleArc, signalHead, signalOpacity, threadLight, threadY,
} from '../../src/auth/motion/threads';
import type { Zone } from '../../src/auth/motion/threads';
import { AuthLayout, BrandPanel, brandFacts } from '../../src/auth/ui';
import { PROFILE } from './helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src/auth');
const FORBIDDEN = /[\u2014\u00b7]/;

// ---------------------------------------------------------------------------------------------------------------
// A layout as the browser measures it at 1440 x 900 (panel 754 x 900, hero 520 wide): the quiet zones of the logo,
// the chain labels, the two headline lines, the three facts and the four footer facts.
// ---------------------------------------------------------------------------------------------------------------

const CHAIN = { x: 48, y: 252, scale: 1 };
const small = (x: number, y: number, w: number, h: number): Zone => ({ x, y, w, h, keep: KEEP.small });
const LABELS: Zone[] = [
  small(51, 377, 36, 16), small(146, 283, 28, 16), small(244, 261, 50, 16),
  small(330, 361, 58, 16), small(440, 377, 58, 16), small(524, 261, 50, 16),
];
const LAYOUT: Layout = {
  width: 754,
  height: 900,
  chain: CHAIN,
  zones: [
    small(48, 40, 145, 28),
    ...LABELS,
    { x: 48, y: 436, w: 505, h: 44, keep: KEEP.large },
    { x: 48, y: 480, w: 310, h: 44, keep: KEEP.large },
    small(48, 546, 388, 30), small(48, 588, 340, 30), small(48, 630, 228, 30),
    small(48, 843, 48, 18), small(124, 843, 160, 18), small(312, 843, 56, 18), small(396, 843, 96, 18),
  ],
};
const LOOM_AT = loomOf(LAYOUT);

// WCAG relative luminance and contrast of sRGB colours.
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('scene maths', () => {
  it('draws the same threads for the same seed, with calm alphas and evenly spaced ranks', () => {
    const a = makeThreads();
    expect(a).toEqual(makeThreads());
    expect(a).toHaveLength(THREAD_COUNT);
    a.forEach((th, i) => {
      expect(th.rank).toBeCloseTo(i / (THREAD_COUNT - 1), 10);
      expect(th.alpha).toBeGreaterThanOrEqual(0.075);
      expect(th.alpha).toBeLessThanOrEqual(0.175);
      // one wave period takes 38 to 72 seconds: slow, never restless
      expect((Math.PI * 2) / th.omega).toBeGreaterThanOrEqual(38);
      expect((Math.PI * 2) / th.omega).toBeLessThanOrEqual(72);
    });
    expect(makeThreads(THREAD_COUNT, 7)).not.toEqual(a);
  });

  it('follows the chain path of the panel: three curves through the six nodes, in order', () => {
    expect(parseCubicPath(CHAIN_PATH)).toHaveLength(3);
    expect(pointAt(CHAIN_ARC, 0)).toEqual({ x: 20, y: 110 });
    const end = pointAt(CHAIN_ARC, 1);
    expect(end.x).toBeCloseTo(500, 6);
    expect(end.y).toBeCloseTo(40, 6);
    expect(NODE_FRACTIONS[0]).toBe(0);
    expect(NODE_FRACTIONS[5]).toBe(1);
    for (let i = 1; i < NODE_FRACTIONS.length; i++) expect(NODE_FRACTIONS[i]).toBeGreaterThan(NODE_FRACTIONS[i - 1]);
    CHAIN_POINTS.forEach(([x, y], i) => {
      const p = pointAt(CHAIN_ARC, NODE_FRACTIONS[i]);
      expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(6);
    });
  });

  it('gathers the threads behind the Evidence node and spreads them at the edges', () => {
    const threads = makeThreads();
    const ug = LOOM_AT.gx / LOOM_AT.width;
    expect(LOOM_AT.gx).toBe(CHAIN.x + CHAIN_POINTS[EVIDENCE][0]);
    expect(LOOM_AT.gy).toBe(CHAIN.y + CHAIN_POINTS[EVIDENCE][1]);
    expect(pinch(ug, LOOM_AT)).toBeCloseTo(1, 10);
    for (const t of [3, 20, 47]) {
      const at = (u: number) => threads.map((th) => threadY(th, u, t, LOOM_AT));
      const spread = (ys: number[]) => Math.max(...ys) - Math.min(...ys);
      expect(spread(at(ug))).toBeLessThanOrEqual(2 * LOOM.spread + 6);
      expect(spread(at(0))).toBeGreaterThan(0.8 * LAYOUT.height);
      expect(spread(at(1))).toBeGreaterThan(0.8 * LAYOUT.height);
    }
  });

  it('moves slowly: a thread moves less than 2px in a frame of a 30 frame per second loop', () => {
    const threads = makeThreads();
    let worst = 0;
    for (const th of threads) {
      for (let u = 0; u <= 1; u += 0.05) {
        for (let t = 2; t < 60; t += 1.7) worst = Math.max(worst, Math.abs(threadY(th, u, t + 1 / 30, LOOM_AT) - threadY(th, u, t, LOOM_AT)));
      }
    }
    expect(worst).toBeLessThan(2);
  });

  it('runs the signal along the chain once per period and lights the nodes in chain order', () => {
    expect(signalHead(SIGNAL.first - 0.01)).toBeNull();
    expect(signalHead(SIGNAL.first)).toBeCloseTo(0, 10);
    expect(signalHead(SIGNAL.first + SIGNAL.travel)).toBeCloseTo(1, 10);
    expect(signalHead(SIGNAL.first + SIGNAL.travel + 0.5)).toBeNull();
    expect(signalHead(SIGNAL.first + SIGNAL.period + 1)).toBeCloseTo(signalHead(SIGNAL.first + 1) as number, 10);
    // each node is dark until the head reaches it, then fully lit, then fades
    const firstLit = NODE_FRACTIONS.map((f) => {
      let t = 0;
      while (nodeGlow(t, f) < 0.99 && t < SIGNAL.first + SIGNAL.travel + 1) t += 0.01;
      return t;
    });
    for (let i = 1; i < firstLit.length; i++) expect(firstLit[i]).toBeGreaterThan(firstLit[i - 1]);
    expect(nodeGlow(firstLit[2] + 3, NODE_FRACTIONS[2])).toBeLessThan(0.1);
    for (const f of NODE_FRACTIONS) expect(nodeGlow(0, f)).toBe(0);
  });

  it('moves the motes deterministically along threads, across the panel, never brighter than their peak', () => {
    for (let t = 0; t < 40; t += 0.37) {
      const motes = motesAt(t, LOOM_AT);
      expect(motes).toEqual(motesAt(t, LOOM_AT));
      expect(motes.length).toBeLessThanOrEqual(MOTES.lanes);
      for (const m of motes) {
        expect(m.thread).toBeGreaterThanOrEqual(0);
        expect(m.thread).toBeLessThan(THREAD_COUNT);
        expect(m.u).toBeGreaterThanOrEqual(-0.03);
        expect(m.u).toBeLessThanOrEqual(1.03);
        expect(m.alpha).toBeGreaterThanOrEqual(0);
        expect(m.alpha).toBeLessThanOrEqual(MOTES.peak);
      }
    }
  });

  it('keeps only a small part of the light on text, with a soft edge', () => {
    const zone = small(100, 100, 50, 20);
    expect(quietFactor(110, 110, [zone])).toBe(KEEP.small);
    expect(quietFactor(100 - QUIET.pad, 110, [zone])).toBe(KEEP.small);
    expect(quietFactor(100 - QUIET.pad - QUIET.feather, 110, [zone])).toBe(1);
    const a = quietFactor(100 - QUIET.pad - 8, 110, [zone]);
    const b = quietFactor(100 - QUIET.pad - 20, 110, [zone]);
    expect(a).toBeGreaterThan(KEEP.small);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
    expect(quietFactor(500, 500, [zone])).toBe(1);
    // the mask the engine draws is the same function, sampled
    const scale = 1;
    const m = maskAlpha({ zones: [zone] }, 300, 200, scale);
    expect(m[110 * 300 + 110]).toBeCloseTo(KEEP.small, 6);
    expect(m[10 * 300 + 290]).toBe(1);
  });

  it('keeps the brand text above WCAG AA over the brightest light the motion adds behind it (L-3)', () => {
    // Model of the panel at its brightest: the panel colour under the ambient lights; the threads (twice their light,
    // for anti-aliasing), a mote at its peak, the waist and the head of the signal, kept only in part by the quiet
    // zone mask; then the halos around the nodes, which the engine draws after the mask. The browser check of e2e/auth-motion.spec.js
    // measures the rendered pixels as well.
    const threads = makeThreads();
    // the panel colour under the two static ambient lights of auth.css (radial gradients that end at 70%)
    const W = LAYOUT.width;
    const H = LAYOUT.height;
    const ambient = (x: number, y: number, cx: number, cy: number, rx: number, ry: number, a: number) =>
      a * Math.max(0, 1 - Math.hypot((x - cx) / rx, (y - cy) / ry) / 0.7);
    const baseAt = (x: number, y: number) => {
      const warm = ambient(x, y, 0.08 * W, 1.04 * H, 0.75 * W, 0.55 * H, 0.15);
      const top = ambient(x, y, 0.92 * W, -0.04 * H, 0.6 * W, 0.4 * H, 0.045);
      return [15, 14, 12].map((c, i) => c + warm * ([232, 115, 26][i] - c) + top * ([242, 238, 231][i] - c));
    };
    // the radial sprite of the engine: 1 at the centre, 0.35 at 30% of the radius, 0 at the radius
    const falloff = (q: number) => (q >= 1 ? 0 : q <= 0.3 ? 1 - (0.65 * q) / 0.3 : (0.35 * (1 - q)) / 0.7);
    const toCanvas = (x: number, y: number) => ({ x: CHAIN.x + x * CHAIN.scale, y: CHAIN.y + y * CHAIN.scale });
    // The glows over one full period of the signal, as the engine draws them: the waist and the head under the mask,
    // the node halos (Evidence never below its steady glow) after it, each with its level at that moment.
    const moments = Array.from({ length: Math.round(SIGNAL.period / 0.04) }, (_, k) => SIGNAL.first + k * 0.04).map((t) => {
      const head = signalHead(t);
      const p = head === null ? null : pointAt(CHAIN_ARC, head);
      return {
        waist: GLOW.waistPeak * nodeGlow(t, NODE_FRACTIONS[EVIDENCE]),
        nodes: NODE_FRACTIONS.map((f, i) => Math.max(GLOW.nodePeak * nodeGlow(t, f), i === EVIDENCE ? GLOW.evidence : 0)),
        head: p && head !== null ? { ...toCanvas(p.x, p.y), a: GLOW.headPeak * signalOpacity(head) } : null,
      };
    });
    const nodesAt = CHAIN_POINTS.map(([nx, ny]) => toCanvas(nx, ny));
    const keepAt = (x: number, y: number) => quietFactor(x, y, LAYOUT.zones);
    const glows = (x: number, y: number) => {
      const fw = falloff(Math.hypot(x - LOOM_AT.gx, y - LOOM_AT.gy) / (GLOW.waist * CHAIN.scale));
      const fn = nodesAt.map((c) => falloff(Math.hypot(x - c.x, y - c.y) / (GLOW.node * CHAIN.scale)));
      const keep = keepAt(x, y);
      let best = 0;
      for (const m of moments) {
        let g = m.waist * fw * keep;
        m.nodes.forEach((a, i) => {
          g += a * fn[i];
        });
        if (m.head) g += m.head.a * falloff(Math.hypot(x - m.head.x, y - m.head.y) / (GLOW.head * CHAIN.scale)) * keep;
        best = Math.max(best, g);
      }
      return best;
    };
    const minimums: Record<string, { color: string; min: number }> = {
      label: { color: '#b9b2a6', min: 4.5 }, meta: { color: '#b3ab9d', min: 4.5 }, fact: { color: '#e6e0d4', min: 4.5 },
      headline: { color: '#f2eee7', min: 3 }, logo: { color: '#f2eee7', min: 4.5 },
    };
    for (const z of LAYOUT.zones) {
      const kind = z.keep === KEEP.large ? 'headline' : z.y > 800 ? 'meta' : z.y < 100 ? 'logo' : z.y > 520 ? 'fact' : 'label';
      let ratio = Infinity;
      for (let y = z.y; y <= z.y + z.h; y += 2) {
        for (let x = z.x; x <= z.x + z.w; x += 3) {
          const keep = quietFactor(x, y, LAYOUT.zones);
          const glow = glows(x, y);
          let light = 0;
          for (let t = 1; t < 60; t += 2.3) light = Math.max(light, threadLight(threads, x, y, t, LOOM_AT) * 2 * keep);
          // threads in their lightest colour (warm white), a mote at its peak, the glows in the accent colour
          const added = [242, 238, 231].map((c, i) => light * c + MOTES.peak * keep * [255, 196, 140][i] + glow * [232, 115, 26][i]);
          const bg = baseAt(x, y).map((c, i) => Math.min(255, c + added[i]));
          ratio = Math.min(ratio, contrast(hex(minimums[kind].color), bg));
        }
      }
      expect(ratio, `${kind} at ${z.x},${z.y}`).toBeGreaterThanOrEqual(minimums[kind].min);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Engine lifecycle with fake browser APIs
// ---------------------------------------------------------------------------------------------------------------

interface FakeCtx {
  calls: Record<string, number>;
}

function fakeContext(): CanvasRenderingContext2D & FakeCtx {
  const calls: Record<string, number> = {};
  const target: Record<string, unknown> = {
    calls,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(target, {
    get(obj, key: string) {
      if (key in obj) {
        const v = obj[key];
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            calls[key] = (calls[key] ?? 0) + 1;
            return (v as (...a: unknown[]) => unknown)(...args);
          };
        }
        return v;
      }
      return (..._args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1;
      };
    },
    set(obj, key: string, value) {
      obj[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & FakeCtx;
}

function fakeCanvas(withContext = true) {
  const attrs = new Map<string, string>();
  const ctx = fakeContext();
  const canvas = {
    width: 300,
    height: 150,
    ctx,
    getContext: () => (withContext ? ctx : null),
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
  };
  return canvas;
}

function fakeSvgPath() {
  const attrs = new Map<string, string>();
  return { style: { opacity: '' }, setAttribute: (k: string, v: string) => void attrs.set(k, v), attrs };
}

function fakeEnv(opts: { dpr?: number } = {}) {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const idle: (() => void)[] = [];
  const subs = { reduced: new Set<() => void>(), page: new Set<() => void>(), size: new Set<() => void>(), screen: new Set<(v: boolean) => void>() };
  const flags = { reduced: false, hidden: false };
  const env: MotionEnv = {
    now: () => now,
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    whenIdle: (cb) => {
      idle.push(cb);
      return () => {
        const i = idle.indexOf(cb);
        if (i >= 0) idle.splice(i, 1);
      };
    },
    pixelRatio: () => opts.dpr ?? 1,
    reducedMotion: { matches: () => flags.reduced, subscribe: (cb) => (subs.reduced.add(cb), () => void subs.reduced.delete(cb)) },
    page: { hidden: () => flags.hidden, subscribe: (cb) => (subs.page.add(cb), () => void subs.page.delete(cb)) },
    observeSize: (_el, cb) => (subs.size.add(cb), () => void subs.size.delete(cb)),
    observeOnScreen: (_el, cb) => (subs.screen.add(cb), () => void subs.screen.delete(cb)),
    createCanvas: () => fakeCanvas() as unknown as HTMLCanvasElement,
  };
  return {
    env,
    flags,
    subs,
    frames,
    idle: () => idle.splice(0).forEach((cb) => cb()),
    /** Advances the clock by `ms` and runs the frames that were waiting. */
    frame(ms = 1000 / 60) {
      now += ms;
      const due = [...frames.values()];
      frames.clear();
      due.forEach((cb) => cb());
    },
    advance(ms: number) {
      now += ms;
    },
    subscriptions: () => subs.reduced.size + subs.page.size + subs.size.size + subs.screen.size,
  };
}

function mount(layout: Layout = LAYOUT, envOpts: { dpr?: number } = {}, withContext = true) {
  const fake = fakeEnv(envOpts);
  const canvas = fakeCanvas(withContext);
  const signal = { glow: fakeSvgPath(), core: fakeSvgPath() };
  let current = layout;
  const engine = createThreadEngine(
    { canvas: canvas as unknown as HTMLCanvasElement, measure: () => current, signal: signal as unknown as { glow: SVGElement; core: SVGElement } },
    fake.env,
  );
  const strokes = () => canvas.ctx.calls.stroke ?? 0;
  return { fake, canvas, signal, engine, strokes, setLayout: (l: Layout) => void (current = l) };
}

describe('motion engine', () => {
  it('waits for an idle moment, then runs at 30 frames per second at most', () => {
    const m = mount();
    expect(m.engine.state).toBe('off');
    expect(m.canvas.getAttribute('data-motion')).toBe('off');
    m.fake.frame();
    expect(m.strokes()).toBe(0);
    m.fake.idle();
    expect(m.engine.state).toBe('running');
    expect(m.canvas.getAttribute('data-motion')).toBe('running');
    expect(m.canvas.hasAttribute('data-ready')).toBe(true);
    // the first frame draws every thread once
    expect(m.strokes()).toBe(THREAD_COUNT);
    for (let i = 0; i < 60; i++) m.fake.frame(1000 / 60);
    const drawn = m.strokes() / THREAD_COUNT - 1;
    expect(drawn).toBeGreaterThanOrEqual(29);
    expect(drawn).toBeLessThanOrEqual(31);
    expect(m.canvas.width).toBe(LAYOUT.width);
    expect(m.canvas.height).toBe(LAYOUT.height);
  });

  it('pauses while the tab is hidden and resumes where it stopped (L-4)', () => {
    const m = mount();
    m.fake.idle();
    // run until the signal is on its way
    for (let i = 0; i < 120; i++) m.fake.frame(1000 / 60);
    const before = Number(m.signal.core.attrs.get('stroke-dashoffset'));
    expect(m.signal.core.style.opacity).not.toBe('0');
    m.fake.flags.hidden = true;
    m.fake.subs.page.forEach((cb) => cb());
    expect(m.engine.state).toBe('paused');
    expect(m.fake.frames.size).toBe(0);
    const strokes = m.strokes();
    m.fake.advance(100_000);
    m.fake.frame();
    expect(m.strokes()).toBe(strokes);
    m.fake.flags.hidden = false;
    m.fake.subs.page.forEach((cb) => cb());
    expect(m.engine.state).toBe('running');
    m.fake.frame(1000 / 60);
    const after = Number(m.signal.core.attrs.get('stroke-dashoffset'));
    // 100 seconds passed while hidden, but the signal moved by one frame only
    expect(Math.abs(after - before)).toBeLessThan(0.05);
  });

  it('pauses while the panel is off screen (L-4)', () => {
    const m = mount();
    m.fake.idle();
    m.fake.subs.screen.forEach((cb) => cb(false));
    expect(m.engine.state).toBe('paused');
    expect(m.fake.frames.size).toBe(0);
    m.fake.subs.screen.forEach((cb) => cb(true));
    expect(m.engine.state).toBe('running');
    expect(m.fake.frames.size).toBe(1);
  });

  it('shows one still frame and no loop with reduced motion, and follows the setting when it changes (L-2)', () => {
    const m = mount();
    m.fake.flags.reduced = true;
    m.fake.idle();
    expect(m.engine.state).toBe('still');
    expect(m.strokes()).toBe(THREAD_COUNT);
    expect(m.fake.frames.size).toBe(0);
    expect(m.canvas.hasAttribute('data-ready')).toBe(true);
    for (let i = 0; i < 30; i++) m.fake.frame();
    expect(m.strokes()).toBe(THREAD_COUNT);
    expect(m.signal.core.attrs.has('stroke-dashoffset')).toBe(false);
    // motes and the signal are not part of the still frame
    expect(m.canvas.ctx.calls.drawImage).toBe(2); // the steady glow at Evidence and the quiet zone mask
    m.fake.flags.reduced = false;
    m.fake.subs.reduced.forEach((cb) => cb());
    expect(m.engine.state).toBe('running');
    m.fake.flags.reduced = true;
    m.fake.subs.reduced.forEach((cb) => cb());
    expect(m.engine.state).toBe('still');
    expect(m.fake.frames.size).toBe(0);
  });

  it('draws one still frame and no loop where the panel collapses to the logo bar and the chain is hidden', () => {
    const bar: Layout = { width: 390, height: 163, chain: null, zones: [small(24, 20, 145, 28)] };
    const m = mount(bar);
    m.fake.idle();
    expect(m.engine.state).toBe('still');
    expect(m.strokes()).toBe(THREAD_COUNT);
    expect(m.fake.frames.size).toBe(0);
    // the loom fits the bar: small waves, the waist halfway down
    const loom = loomOf(bar);
    expect(loom.gy).toBe(163 / 2);
    expect(loom.scale).toBeCloseTo(163 / 640, 6);
    for (const th of makeThreads()) {
      for (let u = 0; u <= 1; u += 0.1) {
        const y = threadY(th, u, ENGINE.stillT, loom);
        expect(y).toBeGreaterThan(-8);
        expect(y).toBeLessThan(171);
      }
    }
    // back to the wide layout: the motion runs again
    m.setLayout(LAYOUT);
    m.fake.subs.size.forEach((cb) => cb());
    expect(m.engine.state).toBe('running');
  });

  it('turns off when the canvas has no size and comes back with it', () => {
    const m = mount();
    m.fake.idle();
    m.setLayout({ width: 0, height: 0, zones: [], chain: null });
    m.fake.subs.size.forEach((cb) => cb());
    expect(m.engine.state).toBe('off');
    expect(m.fake.frames.size).toBe(0);
    m.setLayout(LAYOUT);
    m.fake.subs.size.forEach((cb) => cb());
    expect(m.engine.state).toBe('running');
  });

  it('limits the backing store: device pixel ratio at most 2 and at most 2.6 million pixels', () => {
    const m = mount({ ...LAYOUT, width: 600, height: 800 }, { dpr: 3 });
    m.fake.idle();
    expect(m.canvas.width).toBe(1200);
    expect(m.canvas.height).toBe(1600);
    const big = mount({ ...LAYOUT, width: 1800, height: 1400 }, { dpr: 2 });
    big.fake.idle();
    expect(big.canvas.width * big.canvas.height).toBeLessThanOrEqual(ENGINE.maxBacking * 1.01);
  });

  it('stops everything on destroy, also before it started', () => {
    const m = mount();
    m.fake.idle();
    expect(m.fake.subscriptions()).toBe(4);
    m.engine.destroy();
    expect(m.engine.state).toBe('off');
    expect(m.fake.subscriptions()).toBe(0);
    expect(m.fake.frames.size).toBe(0);
    const early = mount();
    early.engine.destroy();
    early.fake.idle();
    expect(early.engine.state).toBe('off');
    expect(early.fake.subscriptions()).toBe(0);
  });

  it('stays off without a 2D context', () => {
    const m = mount(LAYOUT, {}, false);
    m.fake.idle();
    expect(m.engine.state).toBe('off');
    expect(m.fake.frames.size).toBe(0);
    expect(() => m.engine.relayout()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Markup and stylesheet
// ---------------------------------------------------------------------------------------------------------------

describe('brand panel markup', () => {
  it('keeps the design structure and adds a decorative canvas and the signal paths', () => {
    for (const lang of ['en', 'id'] as const) {
      const html = renderToStaticMarkup(<BrandPanel lang={lang} facts={brandFacts(PROFILE, lang)} />);
      expect(html).toMatch(/<canvas class="au-threads" aria-hidden="true" data-motion="off"><\/canvas>/);
      expect(html).not.toContain('au-mesh');
      expect((html.match(/<circle /g) ?? []).length).toBe(6);
      expect((html.match(/class="au-chain-signal /g) ?? []).length).toBe(2);
      expect((html.match(/pathLength="1"/g) ?? []).length).toBe(2);
      // the chain is drawn in full without the motion: no dash hides it and no node waits for an animation
      expect(html).toMatch(/<path class="au-chain-line" d="M20 110[^"]*" fill="none" stroke="#e8731a" stroke-width="2.5"><\/path>/);
      expect(html).not.toContain('animation-delay');
      const labels = ['chainIssue', 'chainRisk', 'chainControl', 'chainDocument', 'chainEvidence', 'chainFinding'] as const;
      expect(html).toContain(`aria-label="${labels.map((k) => li(TEXT[k], lang)).join(', ')}"`);
      for (const key of [...labels, 'headline', 'factFrameworks', 'factChain', 'factFiles'] as const) expect(html).toContain(li(TEXT[key], lang));
      expect(html).not.toMatch(FORBIDDEN);
    }
  });

  it('keeps every chain label clear of the chain line and the nodes at every hero width, in both languages (L-3)', () => {
    // auth.css sets the label size to max(12px, 32.8px - 4cqw) in viewBox units: 12 when the hero is 520px wide, about
    // 17.8 at 376px (the narrowest hero, a 901px window). Each label is modelled as a monospace box with an allowance:
    // 0.62em per character, 1.05em above the baseline and 0.35em below it. The widest stroke on the chain is the
    // signal glow (4.5 units); a node is a circle of radius 7 with a 2.5 unit stroke.
    const line = sampleArc(parseCubicPath(CHAIN_PATH), 400).points;
    const gapTo = (b: { x0: number; x1: number; y0: number; y1: number }, p: { x: number; y: number }) =>
      Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));
    for (const lang of ['en', 'id'] as const) {
      const html = renderToStaticMarkup(<BrandPanel lang={lang} facts={[]} />);
      const labels = [...html.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle">([^<]+)<\/text>/g)]
        .map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));
      expect(labels.map((l) => l.text)).toEqual(['chainIssue', 'chainRisk', 'chainControl', 'chainDocument', 'chainEvidence', 'chainFinding'].map((k) => li(TEXT[k as keyof typeof TEXT], lang)));
      for (let hero = 376; hero <= 520; hero += 4) {
        const size = Math.max(12, 32.8 - 0.04 * hero);
        for (const l of labels) {
          const half = (0.62 * size * l.text.length) / 2;
          const box = { x0: l.x - half, x1: l.x + half, y0: l.y - 1.05 * size, y1: l.y + 0.35 * size };
          const toLine = Math.min(...line.map((p) => gapTo(box, p))) - 4.5 / 2;
          const toNode = Math.min(...CHAIN_POINTS.map(([x, y]) => gapTo(box, { x, y }))) - (7 + 2.5 / 2);
          expect(toLine, `${l.text} to the line, hero ${hero}px`).toBeGreaterThanOrEqual(3);
          expect(toNode, `${l.text} to a node, hero ${hero}px`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('frames the page as before: brand panel, then the card in main, with the theme and language', () => {
    const html = renderToStaticMarkup(<AuthLayout lang="id" theme="dark" facts={['v1.0.0']}><p>card</p></AuthLayout>);
    expect(html).toMatch(/^<div class="au-root" data-theme="dark" lang="id"><div class="au-brand">/);
    expect(html).toContain('<main class="au-main"><div class="au-card"><p>card</p></div></main>');
  });
});

describe('stylesheet and sources (section L rules)', () => {
  const css = readFileSync(path.join(SRC, 'auth.css'), 'utf8');
  const motionFiles = readdirSync(path.join(SRC, 'motion')).map((f) => readFileSync(path.join(SRC, 'motion', f), 'utf8'));
  const brandRules = css.slice(css.indexOf('/* left: brand panel'), css.indexOf('/* right: the form */'));

  it('loads nothing from another origin and needs no new Content-Security-Policy source (L-1)', () => {
    expect(css).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//);
    const urls = [...css.matchAll(/url\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('data:image/svg+xml')).toBe(true);
    for (const src of motionFiles) {
      expect(src).not.toMatch(/https?:\/\//);
      expect(src).not.toMatch(/\bblob:|new Worker|\beval\(|new Function/);
    }
  });

  it('stops every animation and transition with reduced motion and collapses the panel to the logo bar (L-2, L-4)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\s*\.au-root \*,\.au-root \*::before,\.au-root \*::after\{animation:none!important;transition:none!important\}/);
    const narrow = css.slice(css.indexOf('@media (max-width:900px){'), css.indexOf('@media (max-width:440px){'));
    expect(narrow).toContain('.au-hero,.au-meta{display:none}');
    expect(narrow).not.toContain('au-threads');
    expect(brandRules).not.toMatch(/infinite/);
    expect(css).not.toMatch(/au-mesh|au-drawLoop|au-dotLoop/);
  });

  it('sets no text under 12px and keeps the brand colours (L-3, L-5)', () => {
    for (const m of css.matchAll(/font-size:([\d.]+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    expect(brandRules).toContain('#e8731a');
    expect(brandRules).not.toMatch(/122,79,211/); // the purple glow of the old mesh is gone
  });
});
