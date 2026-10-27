// Scene maths of the sign-in brand panel motion (MILESTONE-2 MOT-02): pure functions, no DOM, so the unit tests can
// check the picture without a browser.
//
// The picture: fine threads (the records of a management system) cross the panel from the left edge, gather into a
// waist behind the Evidence node of the traceability chain and open again towards the right edge. Small motes travel
// along the threads. Every few seconds a signal of light runs the chain from Issue to Finding and lights each node as
// it passes. Around every line of brand text the threads, motes and glows keep only a small part of their light (the
// quiet zones), so the facts stay readable over the moving background (rule L-3).

/** The chain drawing of the brand panel, in the units of its SVG viewBox. */
export const CHAIN_VIEW = { width: 520, height: 150 } as const;
export const CHAIN_PATH = 'M20 110 C 120 110, 120 40, 220 40 S 320 110, 420 110 S 480 60, 500 40';
/** Centres of the six nodes: Issue, Risk, Control, Document, Evidence, Finding. */
export const CHAIN_POINTS: readonly (readonly [number, number])[] = [[20, 110], [120, 80], [220, 40], [320, 80], [420, 110], [500, 40]];
/** Index of the Evidence node in CHAIN_POINTS: the threads gather behind it. */
export const EVIDENCE = 4;

export interface Point {
  x: number;
  y: number;
}

/** A box in canvas pixels (CSS px) around one line of text; `keep` is the share of light the motion keeps there. */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  keep: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------

/** Seeded generator (mulberry32): the same seed always draws the same picture. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Ease in-out sine and its inverse (time at which the eased value reaches `v`). */
export const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
export const easeInOutSineInverse = (v: number) => Math.acos(1 - 2 * clamp(v, 0, 1)) / Math.PI;

// ---------------------------------------------------------------------------------------------------------------
// Chain geometry
// ---------------------------------------------------------------------------------------------------------------

type Cubic = [Point, Point, Point, Point];

/** Cubic segments of a path made of absolute M, C and S commands (the chain path). */
export function parseCubicPath(d: string): Cubic[] {
  const tokens = d.match(/[MCS]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const out: Cubic[] = [];
  let i = 0;
  let cmd = '';
  let cur: Point = { x: 0, y: 0 };
  let lastCtrl: Point | null = null;
  const num = () => Number(tokens[i++]);
  const pt = (): Point => ({ x: num(), y: num() });
  while (i < tokens.length) {
    if (/^[MCS]$/i.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') {
      cur = pt();
      lastCtrl = null;
      cmd = 'C'; // further pairs after M would be lines; the chain has none
    } else if (cmd === 'C') {
      const c1 = pt();
      const c2 = pt();
      const end = pt();
      out.push([cur, c1, c2, end]);
      lastCtrl = c2;
      cur = end;
    } else if (cmd === 'S') {
      const c1 = lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
      const c2 = pt();
      const end = pt();
      out.push([cur, c1, c2, end]);
      lastCtrl = c2;
      cur = end;
    } else {
      throw new Error(`Unsupported path command: ${cmd}`);
    }
  }
  return out;
}

function cubicAt([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
}

/** The path sampled by arc length: points and the running length at each point. */
export interface ArcTable {
  points: Point[];
  lengths: number[];
  total: number;
}

export function sampleArc(cubics: Cubic[], perSegment = 96): ArcTable {
  const points: Point[] = [];
  const lengths: number[] = [];
  let total = 0;
  cubics.forEach((c, si) => {
    for (let k = si === 0 ? 0 : 1; k <= perSegment; k++) {
      const p = cubicAt(c, k / perSegment);
      if (points.length) total += Math.hypot(p.x - points[points.length - 1].x, p.y - points[points.length - 1].y);
      points.push(p);
      lengths.push(total);
    }
  });
  return { points, lengths, total };
}

/** The point at `s` (0 to 1) of the path's length. */
export function pointAt(table: ArcTable, s: number): Point {
  const target = clamp(s, 0, 1) * table.total;
  let lo = 0;
  let hi = table.lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table.lengths[mid] < target) lo = mid;
    else hi = mid;
  }
  const span = table.lengths[hi] - table.lengths[lo] || 1;
  const t = clamp((target - table.lengths[lo]) / span, 0, 1);
  return { x: lerp(table.points[lo].x, table.points[hi].x, t), y: lerp(table.points[lo].y, table.points[hi].y, t) };
}

/** The share of the path's length at the sample nearest to `p`. */
export function fractionNear(table: ArcTable, p: Point): number {
  let best = 0;
  let bestD = Infinity;
  table.points.forEach((q, k) => {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return table.lengths[best] / table.total;
}

export const CHAIN_ARC: ArcTable = sampleArc(parseCubicPath(CHAIN_PATH));
/** Where each node sits along the chain (0 to 1), in order from Issue to Finding. */
export const NODE_FRACTIONS: readonly number[] = CHAIN_POINTS.map(([x, y]) => fractionNear(CHAIN_ARC, { x, y }));

// ---------------------------------------------------------------------------------------------------------------
// The signal along the chain
// ---------------------------------------------------------------------------------------------------------------

/** Timing of the signal, in seconds of running time: first run, then one run per period. */
export const SIGNAL = { first: 1.2, period: 11, travel: 3.4, dash: 0.07, rise: 0.12, decay: 1.1 } as const;

/** Position of the signal's head along the chain (0 to 1), or null between runs. */
export function signalHead(t: number): number | null {
  const local = t - SIGNAL.first;
  if (local < 0) return null;
  const c = local % SIGNAL.period;
  if (c > SIGNAL.travel) return null;
  return easeInOutSine(c / SIGNAL.travel);
}

/** Opacity of the visible dash of the signal: fades in at Issue and out at Finding. */
export function signalOpacity(head: number): number {
  return Math.min(1, smoothstep(0, 0.06, head), 1 - smoothstep(0.94, 1, head));
}

/** Light of a node (0 to 1): rises when the head reaches the node, then decays until the next run. */
export function nodeGlow(t: number, fraction: number): number {
  const passAt = SIGNAL.travel * easeInOutSineInverse(fraction);
  const local = t - SIGNAL.first - passAt;
  if (local < 0) return 0;
  const dt = local % SIGNAL.period;
  if (dt < SIGNAL.rise) return dt / SIGNAL.rise;
  return Math.exp(-(dt - SIGNAL.rise) / SIGNAL.decay);
}

// ---------------------------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------------------------

export interface Thread {
  /** 0 (top) to 1 (bottom): the thread's place at the edges and inside the waist. */
  rank: number;
  /** Wave amplitude (CSS px), spatial frequency (cycles per panel width), phase and angular speed (rad/s). */
  amp: number;
  freq: number;
  phase: number;
  omega: number;
  alpha: number;
  accent: boolean;
}

export const THREAD_COUNT = 34;
export const THREAD_SEED = 2026;
/** Waist of the loom: half-spread (CSS px) and width of the pinch (share of the panel width). */
export const LOOM = { spread: 26, sigma: 0.26, settle: 1.6 } as const;
/** Colours as RGB: warm white of the text, accent of the brand (L-5). */
export const WARM: readonly [number, number, number] = [242, 238, 231];
export const ACCENT: readonly [number, number, number] = [232, 115, 26];

export function makeThreads(count = THREAD_COUNT, seed = THREAD_SEED): Thread[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    rank: count > 1 ? i / (count - 1) : 0.5,
    amp: 8 + rnd() * 16,
    freq: 0.6 + rnd() * 1.0,
    phase: rnd() * Math.PI * 2,
    omega: (Math.PI * 2) / (38 + rnd() * 34),
    alpha: 0.075 + rnd() * 0.1,
    accent: rnd() < 0.45,
  }));
}

/**
 * Size of the canvas and the waist of the loom (the Evidence node), in CSS px. `scale` shrinks the waves and the
 * waist for a short canvas (the logo bar of the narrow layout); 1 when the panel is 640px tall or more.
 */
export interface Loom {
  width: number;
  height: number;
  gx: number;
  gy: number;
  scale?: number;
}

/** The wave and waist scale of a canvas `height` px tall. */
export const loomScale = (height: number) => clamp(height / 640, 0.15, 1);

/** Strength of the pinch at `u` (0 at the left edge, 1 at the right edge). */
export function pinch(u: number, loom: Loom): number {
  const ug = loom.width > 0 ? loom.gx / loom.width : 0.6;
  return Math.exp(-(((u - ug) / LOOM.sigma) ** 2));
}

/** The y of a thread at `u` and running time `t`. The pinch settles in over the first seconds. */
export function threadY(th: Thread, u: number, t: number, loom: Loom): number {
  const H = loom.height;
  const edge = lerp(H * (0.04 + 0.94 * th.rank), H * (0.02 + 0.94 * th.rank), u);
  const k = loom.scale ?? 1;
  const inWaist = loom.gy + (th.rank - 0.5) * 2 * LOOM.spread * k;
  const g = pinch(u, loom) * lerp(0.6, 1, smoothstep(0, LOOM.settle, t));
  const wave = th.amp * k * Math.sin(Math.PI * 2 * th.freq * u + th.phase + th.omega * t) * (1 - 0.9 * g);
  return lerp(edge, inWaist, g) + wave;
}

/** Number of points per thread; the engine smooths between them. */
export const THREAD_SAMPLES = 48;

// ---------------------------------------------------------------------------------------------------------------
// Motes: stateless, so a frame depends only on its time
// ---------------------------------------------------------------------------------------------------------------

export interface Mote {
  thread: number;
  /** 0 to 1 across the panel (a little beyond the edges). */
  u: number;
  alpha: number;
}

export const MOTES = { lanes: 7, peak: 0.55, minPeriod: 14, maxPeriod: 20, travel: 0.86 } as const;

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The motes visible at running time `t`. */
export function motesAt(t: number, loom: Loom, threadCount = THREAD_COUNT): Mote[] {
  const out: Mote[] = [];
  for (let k = 0; k < MOTES.lanes; k++) {
    const period = MOTES.minPeriod + ((hash(k, 7) % 1000) / 1000) * (MOTES.maxPeriod - MOTES.minPeriod);
    const offset = ((hash(k, 11) % 1000) / 1000) * period;
    const local = t + offset;
    const n = Math.floor(local / period);
    const p = (local - n * period) / period / MOTES.travel;
    if (p > 1) continue;
    const u = -0.03 + 1.06 * p;
    const thread = hash(k, n) % threadCount;
    const alpha = MOTES.peak * Math.sin(Math.PI * p) ** 1.5 * (0.45 + 0.55 * pinch(clamp(u, 0, 1), loom));
    out.push({ thread, u, alpha });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Quiet zones
// ---------------------------------------------------------------------------------------------------------------

/** Padding around a text box and the width of the soft edge (CSS px). */
export const QUIET = { pad: 14, feather: 28 } as const;
/** Light kept behind small text (labels, facts, version line) and behind the headline (24px and more). */
export const KEEP = { small: 0.08, large: 0.3 } as const;

/** Share of light the motion keeps at (x, y): 1 away from text, `keep` on it, with a soft edge between. */
export function quietFactor(x: number, y: number, zones: readonly Zone[]): number {
  let f = 1;
  for (const z of zones) {
    const x0 = z.x - QUIET.pad;
    const y0 = z.y - QUIET.pad;
    const x1 = z.x + z.w + QUIET.pad;
    const y1 = z.y + z.h + QUIET.pad;
    const dx = Math.max(x0 - x, 0, x - x1);
    const dy = Math.max(y0 - y, 0, y - y1);
    const d = Math.hypot(dx, dy);
    if (d >= QUIET.feather) continue;
    const v = z.keep + (1 - z.keep) * smoothstep(0, QUIET.feather, d);
    if (v < f) f = v;
  }
  return f;
}

/**
 * The light the threads add at (x, y) before the quiet zones (sum of alpha times pixel coverage of a 1px line),
 * as the canvas draws it with additive blending. Used by the tests to bound the brightness behind text.
 */
export function threadLight(threads: readonly Thread[], x: number, y: number, t: number, loom: Loom): number {
  const u = loom.width > 0 ? x / loom.width : 0;
  let sum = 0;
  for (const th of threads) {
    const cover = 1 - Math.abs(threadY(th, u, t, loom) - y);
    if (cover > 0) sum += th.alpha * cover;
  }
  return sum;
}
