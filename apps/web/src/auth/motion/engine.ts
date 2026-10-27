// Canvas renderer and lifecycle of the sign-in brand panel motion (MILESTONE-2 MOT-02).
//
// - States (written to the canvas as `data-motion`): `off` (not started, no 2D context, or the canvas has no size),
//   `running`, `paused` (tab hidden or canvas off screen: no frames are drawn, L-4) and `still` (one still frame, no
//   loop: with prefers-reduced-motion, L-2, and where the panel collapses to the logo bar and the chain is hidden).
// - The engine starts in an idle callback, so the form paints and takes focus first. Frames are capped at 30 per
//   second and the clock counts running time only, so a paused panel resumes where it stopped.
// - Every browser API comes through `MotionEnv`, so the unit tests drive the engine with fakes.
import {
  ACCENT, CHAIN_ARC, CHAIN_POINTS, EVIDENCE, NODE_FRACTIONS, QUIET, SIGNAL, THREAD_SAMPLES, WARM, makeThreads, motesAt,
  loomScale, nodeGlow, pointAt, signalHead, signalOpacity, smoothstep, threadY,
} from './threads';
import type { Loom, Zone } from './threads';

export type MotionState = 'off' | 'running' | 'paused' | 'still';

/** Where the chain SVG sits on the canvas: its top left corner and the scale of its viewBox (CSS px). */
export interface ChainPlacement {
  x: number;
  y: number;
  scale: number;
}

/** What the engine needs to know about the panel, in CSS px relative to the canvas. */
export interface Layout {
  width: number;
  height: number;
  zones: Zone[];
  chain: ChainPlacement | null;
}

export interface MotionEnv {
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  /** Runs `cb` once the page is idle (or soon after); returns a cancel function. */
  whenIdle(cb: () => void): () => void;
  pixelRatio(): number;
  reducedMotion: { matches(): boolean; subscribe(cb: () => void): () => void };
  page: { hidden(): boolean; subscribe(cb: () => void): () => void };
  observeSize(el: Element, cb: () => void): () => void;
  observeOnScreen(el: Element, cb: (onScreen: boolean) => void): () => void;
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

export interface SignalPaths {
  glow: SVGElement;
  core: SVGElement;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  measure: () => Layout;
  signal?: SignalPaths | null;
}

export interface ThreadEngine {
  readonly state: MotionState;
  /** Measures the panel again (fonts loaded, language changed, entrance finished) and redraws. */
  relayout(): void;
  destroy(): void;
}

/** Frame cap, longest clock step after a stall, time of the still frame and the most backing pixels. */
export const ENGINE = { frameMs: 1000 / 30, maxStep: 0.1, stillT: 8, maxBacking: 2.6e6, maskScale: 1 / 3 } as const;
/**
 * Radii (chain viewBox units; `mote` in CSS px) and peak opacities of the glows: node halos, the steady glow at
 * Evidence, the head of the signal, and the waist of the threads, which lights up when the signal reaches Evidence.
 */
export const GLOW = { node: 30, head: 46, nodePeak: 0.66, evidence: 0.2, headPeak: 0.32, waist: 78, waistPeak: 0.26, mote: 9 } as const;
const SPRITE = 64;

export function browserEnv(win: Window & typeof globalThis): MotionEnv {
  const doc = win.document;
  const mq = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  return {
    now: () => win.performance.now(),
    requestFrame: (cb) => win.requestAnimationFrame(() => cb()),
    cancelFrame: (id) => win.cancelAnimationFrame(id),
    whenIdle: (cb) => {
      if (typeof win.requestIdleCallback === 'function') {
        const id = win.requestIdleCallback(() => cb(), { timeout: 300 });
        return () => win.cancelIdleCallback(id);
      }
      const id = win.setTimeout(cb, 120);
      return () => win.clearTimeout(id);
    },
    pixelRatio: () => win.devicePixelRatio || 1,
    reducedMotion: {
      matches: () => Boolean(mq?.matches),
      subscribe: (cb) => {
        if (!mq) return () => {};
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', cb);
          return () => mq.removeEventListener('change', cb);
        }
        mq.addListener(cb);
        return () => mq.removeListener(cb);
      },
    },
    page: {
      hidden: () => doc.visibilityState === 'hidden',
      subscribe: (cb) => {
        doc.addEventListener('visibilitychange', cb);
        return () => doc.removeEventListener('visibilitychange', cb);
      },
    },
    observeSize: (el, cb) => {
      if (typeof win.ResizeObserver === 'function') {
        const ro = new win.ResizeObserver(() => cb());
        ro.observe(el);
        return () => ro.disconnect();
      }
      win.addEventListener('resize', cb);
      return () => win.removeEventListener('resize', cb);
    },
    observeOnScreen: (el, cb) => {
      if (typeof win.IntersectionObserver !== 'function') return () => {};
      const io = new win.IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) cb(last.isIntersecting);
      });
      io.observe(el);
      return () => io.disconnect();
    },
    createCanvas: (width, height) => {
      const c = doc.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    },
  };
}

/** The share of light kept at each pixel of a canvas of `w` x `h` pixels that covers the layout at `scale`. */
export function maskAlpha(layout: Pick<Layout, 'zones'>, w: number, h: number, scale: number): Float32Array {
  const out = new Float32Array(w * h).fill(1);
  const reach = QUIET.pad + QUIET.feather;
  for (const z of layout.zones) {
    if (!(z.w > 0 && z.h > 0)) continue;
    const x0 = z.x - QUIET.pad;
    const y0 = z.y - QUIET.pad;
    const x1 = z.x + z.w + QUIET.pad;
    const y1 = z.y + z.h + QUIET.pad;
    const i0 = Math.max(0, Math.floor((z.x - reach) * scale));
    const i1 = Math.min(w - 1, Math.ceil((z.x + z.w + reach) * scale));
    const j0 = Math.max(0, Math.floor((z.y - reach) * scale));
    const j1 = Math.min(h - 1, Math.ceil((z.y + z.h + reach) * scale));
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) / scale;
      const dy = Math.max(y0 - y, 0, y - y1);
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) / scale;
        const dx = Math.max(x0 - x, 0, x - x1);
        const d = Math.hypot(dx, dy);
        if (d >= QUIET.feather) continue;
        const v = z.keep + (1 - z.keep) * smoothstep(0, QUIET.feather, d);
        const k = j * w + i;
        if (v < out[k]) out[k] = v;
      }
    }
  }
  return out;
}

/**
 * The loom of a layout: it gathers behind the Evidence node; without a chain (the logo bar of the narrow layout) it
 * gathers at 62% of the width, halfway down.
 */
export function loomOf(layout: Layout): Loom {
  const { width, height, chain } = layout;
  const scale = loomScale(height);
  if (!chain) return { width, height, gx: width * 0.62, gy: height * 0.5, scale };
  const [ex, ey] = CHAIN_POINTS[EVIDENCE];
  return { width, height, gx: chain.x + ex * chain.scale, gy: chain.y + ey * chain.scale, scale };
}

export function createThreadEngine({ canvas, measure, signal }: EngineOptions, env: MotionEnv): ThreadEngine {
  let state: MotionState = 'off';
  canvas.setAttribute('data-motion', state);
  const setState = (next: MotionState) => {
    if (next === state) return;
    state = next;
    canvas.setAttribute('data-motion', next);
  };
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { get state() { return state; }, relayout() {}, destroy() {} };
  }

  const threads = makeThreads();
  const styles = threads.map((th) => {
    const [r, g, b] = th.accent ? ACCENT : WARM;
    return `rgba(${r},${g},${b},${th.alpha.toFixed(3)})`;
  });
  let moteSprite: HTMLCanvasElement | null = null;
  let haloSprite: HTMLCanvasElement | null = null;
  let layout: Layout | null = null;
  let loom: Loom = { width: 0, height: 0, gx: 0, gy: 0 };
  let mask: HTMLCanvasElement | null = null;
  let dpr = 1;
  let started = false;
  let destroyed = false;
  let onScreen = true;
  let frame = 0;
  let clock = 0;
  let lastNow = 0;
  let lastDraw = -Infinity;
  let ready = false;
  let signalShown = false;
  const unsubscribe: (() => void)[] = [];

  function sprite(rgb: readonly [number, number, number], core: number): HTMLCanvasElement {
    const c = env.createCanvas(SPRITE, SPRITE);
    const g = c.getContext('2d');
    if (g) {
      const [r, gr, b] = rgb;
      const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
      grad.addColorStop(0, `rgba(${r},${gr},${b},1)`);
      grad.addColorStop(core, `rgba(${r},${gr},${b},0.35)`);
      grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE, SPRITE);
    }
    return c;
  }

  function buildMask(l: Layout): HTMLCanvasElement | null {
    const w = Math.max(1, Math.ceil(l.width * ENGINE.maskScale));
    const h = Math.max(1, Math.ceil(l.height * ENGINE.maskScale));
    const c = env.createCanvas(w, h);
    const mctx = c.getContext('2d');
    if (!mctx) return null;
    const alpha = maskAlpha(l, w, h, ENGINE.maskScale);
    const img = mctx.createImageData(w, h);
    for (let k = 0; k < alpha.length; k++) {
      const o = k * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(alpha[k] * 255);
    }
    mctx.putImageData(img, 0, 0);
    return c;
  }

  function paintSignal(head: number | null) {
    if (!signal) return;
    if (head === null) {
      if (signalShown) {
        signal.glow.style.opacity = '0';
        signal.core.style.opacity = '0';
        signalShown = false;
      }
      return;
    }
    const offset = (SIGNAL.dash - head).toFixed(4);
    const opacity = signalOpacity(head).toFixed(3);
    for (const el of [signal.glow, signal.core]) {
      el.setAttribute('stroke-dashoffset', offset);
      el.style.opacity = opacity;
    }
    signalShown = true;
  }

  function draw(t: number, still: boolean) {
    if (!ctx || !layout || !mask || !moteSprite || !haloSprite) return;
    const W = layout.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    // Threads: points along the width, smoothed through their midpoints.
    for (let i = 0; i < threads.length; i++) {
      const th = threads[i];
      ctx.strokeStyle = styles[i];
      ctx.beginPath();
      let px = -0.02 * W;
      let py = threadY(th, -0.02, t, loom);
      ctx.moveTo(px, py);
      for (let k = 1; k <= THREAD_SAMPLES; k++) {
        const u = -0.02 + (1.04 * k) / THREAD_SAMPLES;
        const x = u * W;
        const y = threadY(th, u, t, loom);
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x;
        py = y;
      }
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    // Motes travelling along the threads.
    if (!still) {
      for (const m of motesAt(t, loom, threads.length)) {
        const x = m.u * W;
        const y = threadY(threads[m.thread], m.u, t, loom);
        ctx.globalAlpha = m.alpha;
        ctx.drawImage(moteSprite, x - GLOW.mote, y - GLOW.mote, GLOW.mote * 2, GLOW.mote * 2);
      }
    }

    // The light the head of the signal carries along the chain, and the waist of the threads, which lights up when
    // the signal reaches Evidence. Both lie close to the chain labels, so they stay under the quiet zones like the
    // threads.
    const chain = layout.chain;
    const at = (x: number, y: number) => (chain ? { x: chain.x + x * chain.scale, y: chain.y + y * chain.scale } : { x, y });
    const halo = haloSprite;
    const glowAt = (x: number, y: number, radius: number, alpha: number) => {
      if (alpha < 0.004) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(halo, x - radius, y - radius, radius * 2, radius * 2);
    };
    const head = still || !chain ? null : signalHead(t);
    if (chain && !still) {
      glowAt(loom.gx, loom.gy, GLOW.waist * chain.scale, GLOW.waistPeak * nodeGlow(t, NODE_FRACTIONS[EVIDENCE]));
      if (head !== null) {
        const on = pointAt(CHAIN_ARC, head);
        const p = at(on.x, on.y);
        glowAt(p.x, p.y, GLOW.head * chain.scale, GLOW.headPeak * signalOpacity(head));
      }
    }

    // Quiet zones around the text: everything drawn so far keeps only a small part of its light there.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);

    // Light around the nodes, after the mask: these halos are centred on the nodes and fade out before the labels,
    // so the quiet zones of the labels do not dim them. Each node lights up as the head passes; Evidence keeps a
    // steady glow.
    if (chain) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      CHAIN_POINTS.forEach(([x, y], i) => {
        const lit = still ? 0 : nodeGlow(t, NODE_FRACTIONS[i]) * GLOW.nodePeak;
        const c = at(x, y);
        glowAt(c.x, c.y, GLOW.node * chain.scale, Math.max(lit, i === EVIDENCE ? GLOW.evidence : 0));
      });
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';

    paintSignal(head);
    if (!ready) {
      ready = true;
      canvas.setAttribute('data-ready', '');
    }
  }

  function tick() {
    frame = 0;
    if (state !== 'running') return;
    const now = env.now();
    clock += Math.min(Math.max(now - lastNow, 0) / 1000, ENGINE.maxStep);
    lastNow = now;
    if (now - lastDraw >= ENGINE.frameMs - 2) {
      lastDraw = now;
      draw(clock, false);
    }
    frame = env.requestFrame(tick);
  }

  function update(redraw: boolean) {
    let next: MotionState;
    if (!layout || layout.width < 2 || layout.height < 2 || !mask) next = 'off';
    else if (env.reducedMotion.matches() || !layout.chain) next = 'still';
    else if (env.page.hidden() || !onScreen) next = 'paused';
    else next = 'running';
    const previous = state;
    setState(next);
    if (next !== 'running' && frame) {
      env.cancelFrame(frame);
      frame = 0;
    }
    if (next === 'off') {
      paintSignal(null);
      return;
    }
    if (next === 'still') {
      if (redraw || previous !== 'still') draw(ENGINE.stillT, true);
      return;
    }
    if (redraw) draw(clock, false);
    if (next === 'running' && !frame) {
      lastNow = env.now();
      lastDraw = redraw ? lastNow : -Infinity;
      frame = env.requestFrame(tick);
    }
  }

  function relayout() {
    if (!started || destroyed) return;
    layout = measure();
    if (layout.width >= 2 && layout.height >= 2) {
      const area = layout.width * layout.height;
      dpr = Math.min(env.pixelRatio(), 2);
      if (area * dpr * dpr > ENGINE.maxBacking) dpr = Math.sqrt(ENGINE.maxBacking / area);
      const bw = Math.max(1, Math.round(layout.width * dpr));
      const bh = Math.max(1, Math.round(layout.height * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      loom = loomOf(layout);
      mask = buildMask(layout);
      moteSprite ??= sprite([255, 196, 140], 0.22);
      haloSprite ??= sprite(ACCENT, 0.3);
    }
    update(true);
  }

  const cancelIdle = env.whenIdle(() => {
    if (destroyed) return;
    started = true;
    unsubscribe.push(
      env.observeSize(canvas, relayout),
      env.observeOnScreen(canvas, (visible) => {
        onScreen = visible;
        update(false);
      }),
      env.page.subscribe(() => update(false)),
      env.reducedMotion.subscribe(() => update(true)),
    );
    relayout();
  });

  return {
    get state() {
      return state;
    },
    relayout,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelIdle();
      unsubscribe.splice(0).forEach((off) => off());
      if (frame) env.cancelFrame(frame);
      frame = 0;
      setState('off');
    },
  };
}
