// Pure geometry of the illustration scenes (MILESTONE-2 MOT-03): smooth paths through points, points on a cubic
// curve, the seal outline and the steps the Getting started path lights. No DOM, so the unit tests check it directly.

export interface Pt {
  x: number;
  y: number;
}

/** One cubic Bezier segment from `p0` to `p1`. */
export interface Cubic {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p1: Pt;
}

const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (p: Pt) => `${round(p.x)} ${round(p.y)}`;

/**
 * Cubic segments of a Catmull-Rom curve through `points` (uniform, tension 1/6): segment i runs from point i to
 * point i + 1. A part of the path (the first k segments) lies exactly on the whole path, so a lit thread can be drawn
 * over its dashed road.
 */
export function smoothSegments(points: readonly Pt[]): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const before = points[i - 1] ?? p0;
    const after = points[i + 2] ?? p1;
    out.push({
      p0,
      c1: { x: p0.x + (p1.x - before.x) / 6, y: p0.y + (p1.y - before.y) / 6 },
      c2: { x: p1.x - (after.x - p0.x) / 6, y: p1.y - (after.y - p0.y) / 6 },
      p1,
    });
  }
  return out;
}

/** The `d` attribute of connected cubic segments; an empty string for none. */
export function pathOf(segments: readonly Cubic[]): string {
  if (!segments.length) return '';
  return `M${fmt(segments[0].p0)}` + segments.map((s) => ` C${fmt(s.c1)} ${fmt(s.c2)} ${fmt(s.p1)}`).join('');
}

/** The point at `t` (0 to 1) of a cubic segment. */
export function cubicAt(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p1.x, y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p1.y };
}

/** A closed star outline (the seal): `points` tips at `outer`, the notches between them at `inner`. */
export function rosette(cx: number, cy: number, outer: number, inner: number, points: number): string {
  const corners: Pt[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI * i) / points - Math.PI / 2;
    corners.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return `M${corners.map(fmt).join(' L')} Z`;
}

/**
 * The steps of the Getting started path that are lit for a share of the checklist done (0 to 1). Any progress lights
 * the first step; only a complete checklist lights the last step (and the flag). Out of range values are clamped.
 */
export function litSteps(progress: number, steps: number): number {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  if (p >= 1) return steps;
  if (p <= 0) return 0;
  return Math.min(steps - 1, Math.max(1, Math.ceil(p * steps)));
}
