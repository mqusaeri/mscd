// DOM glue of the brand panel motion (MILESTONE-2 MOT-02): measures the panel's text and chain, mounts the canvas
// engine and keeps its layout current. BrandPanel (../ui.tsx) calls `mountBrandMotion` from an effect.
import { createThreadEngine, browserEnv } from './engine';
import type { Layout, SignalPaths, ThreadEngine } from './engine';
import { CHAIN_VIEW, KEEP } from './threads';
import type { Zone } from './threads';

/** Brand text whose line boxes become quiet zones; the chain labels are measured as SVG text. */
const TEXT_SELECTOR = '.au-logo, .au-hero h1, .au-fact, .au-meta > span';
const LABEL_SELECTOR = 'svg.au-chain text';
/** Text of this size or larger keeps more of the motion behind it (it has more contrast to spare). */
const LARGE_TEXT_PX = 24;

/** Text boxes and the chain position, relative to the canvas, in CSS px. */
export function measureBrand(panel: HTMLElement, canvas: HTMLCanvasElement): Layout {
  const base = canvas.getBoundingClientRect();
  if (base.width < 2 || base.height < 2) return { width: 0, height: 0, zones: [], chain: null };
  const doc = panel.ownerDocument;
  const view = doc.defaultView;
  const zones: Zone[] = [];
  const add = (r: DOMRect, keep: number) => {
    if (r.width > 0 && r.height > 0) zones.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, keep });
  };
  panel.querySelectorAll<HTMLElement>(TEXT_SELECTOR).forEach((el) => {
    const size = view ? parseFloat(view.getComputedStyle(el).fontSize) : 14;
    const keep = size >= LARGE_TEXT_PX ? KEEP.large : KEEP.small;
    const range = doc.createRange();
    range.selectNodeContents(el);
    Array.from(range.getClientRects()).forEach((r) => add(r, keep));
    range.detach();
  });
  panel.querySelectorAll<SVGTextElement>(LABEL_SELECTOR).forEach((el) => add(el.getBoundingClientRect(), KEEP.small));
  const svg = panel.querySelector<SVGSVGElement>('svg.au-chain');
  const sr = svg?.getBoundingClientRect();
  const chain = sr && sr.width > 0 ? { x: sr.left - base.left, y: sr.top - base.top, scale: sr.width / CHAIN_VIEW.width } : null;
  return { width: base.width, height: base.height, zones, chain };
}

export interface BrandMotion {
  relayout(): void;
  destroy(): void;
}

/** Starts the motion of a brand panel. Text moves once more after fonts load and after the entrance of the hero. */
export function mountBrandMotion(panel: HTMLElement, canvas: HTMLCanvasElement, signal: SignalPaths | null): BrandMotion {
  const view = panel.ownerDocument.defaultView;
  if (!view) return { relayout() {}, destroy() {} };
  const engine: ThreadEngine = createThreadEngine({ canvas, measure: () => measureBrand(panel, canvas), signal }, browserEnv(view as Window & typeof globalThis));
  let alive = true;
  const relayout = () => {
    if (alive) engine.relayout();
  };
  panel.addEventListener('animationend', relayout);
  panel.ownerDocument.fonts?.ready.then(relayout, () => {});
  return {
    relayout,
    destroy() {
      alive = false;
      panel.removeEventListener('animationend', relayout);
      engine.destroy();
    },
  };
}
