// The scenes of the illustration library (MILESTONE-2 MOT-03, section L). Every scene is drawn on one 240 by 160
// stage, in the colour tokens of src/styles.css through the .il- classes of illustrations.css, so it follows the light
// and the dark theme. The family shares one idea: the golden thread of the product (the accent line that links an
// issue to its evidence) runs to where the next thing belongs. An empty scene ends the thread at an empty place, a
// finished scene runs it through every node, an error breaks it.
//
// Each element that moves gets its entrance timing from `kit.at(delay, duration)`; the CSS gives the movement. Every
// entrance ends within ENTRANCE_MS, then the picture stays still: no loop, nothing hidden at rest.
import type { CSSProperties, ReactNode } from 'react';
import { cubicAt, pathOf, rosette, smoothSegments } from './geometry';
import type { Cubic, Pt } from './geometry';

/** The scenes, by the name screens pass to `<Illustration scene>`. */
export const SCENES = [
  'getting-started', 'no-systems', 'no-documents', 'no-evidence', 'no-findings', 'all-done', 'error', 'offline',
] as const;
export type SceneName = (typeof SCENES)[number];

/** The stage of every scene, in viewBox units. */
export const STAGE = { width: 240, height: 160 } as const;

/** Every entrance animation of a scene ends by this time, in milliseconds. */
export const ENTRANCE_MS = 1200;

/** The steps of the Getting started path. */
export const PATH_STEPS = 5;

export interface SceneKit {
  /** A document-unique id for a definition of this instance. */
  id(name: string): string;
  /** The timing of one entrance step, in milliseconds. */
  at(delay: number, duration: number): CSSProperties;
  /** Getting started: the steps that are lit (0 to PATH_STEPS). */
  lit: number;
}

type Scene = (kit: SceneKit) => ReactNode;

// ---------------------------------------------------------------------------------------------------------------
// Shared marks
// ---------------------------------------------------------------------------------------------------------------

/** A tick inside a circle of about 9 units at (x, y). */
const tick = (x: number, y: number) => `M${x - 3.8} ${y + 0.3} L${x - 1.1} ${y + 3} L${x + 3.9} ${y - 2.6}`;

/** A page outline with a folded top right corner. */
function page(x: number, y: number, w: number, h: number, fold: number, r = 6): { body: string; fold: string } {
  const right = x + w;
  const bottom = y + h;
  return {
    body: `M${x + r} ${y} H${right - fold} L${right} ${y + fold} V${bottom - r} A${r} ${r} 0 0 1 ${right - r} ${bottom} H${x + r} A${r} ${r} 0 0 1 ${x} ${bottom - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`,
    fold: `M${right - fold} ${y} V${y + fold - 4} A4 4 0 0 0 ${right - fold + 4} ${y + fold} H${right}`,
  };
}

/** A clockwise arc of radius r around (cx, cy) from angle a0 to a1 (degrees, 0 is east), with an arrow head at a1. */
function arcArrow(cx: number, cy: number, r: number, a0: number, a1: number): { arc: string; head: string } {
  const rad = (a: number) => (a * Math.PI) / 180;
  const at = (a: number): Pt => ({ x: cx + r * Math.cos(rad(a)), y: cy + r * Math.sin(rad(a)) });
  const p0 = at(a0);
  const p1 = at(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  // Tangent of a clockwise turn at a1, then the two barbs of the head, 3.6 units long and 38 degrees off it.
  const tx = -Math.sin(rad(a1));
  const ty = Math.cos(rad(a1));
  const barb = (turn: number) => {
    const c = Math.cos(rad(turn));
    const s = Math.sin(rad(turn));
    return { x: p1.x - 3.6 * (tx * c - ty * s), y: p1.y - 3.6 * (tx * s + ty * c) };
  };
  const b1 = barb(38);
  const b2 = barb(-38);
  const f = (n: number) => Math.round(n * 100) / 100;
  return {
    arc: `M${f(p0.x)} ${f(p0.y)} A${r} ${r} 0 ${large} 1 ${f(p1.x)} ${f(p1.y)}`,
    head: `M${f(b1.x)} ${f(b1.y)} L${f(p1.x)} ${f(p1.y)} L${f(b2.x)} ${f(b2.y)}`,
  };
}

/** A soft ground shadow under an object. */
const Ground = ({ cx, cy, rx, kit, delay = 0 }: { cx: number; cy: number; rx: number; kit: SceneKit; delay?: number }) => (
  <ellipse className="il-fade il-shade" style={kit.at(delay, 420)} cx={cx} cy={cy} rx={rx} ry={4} />
);

/** A thread node that lights up: a paper ring keeps it apart from the line it sits on. */
const Node = ({ p, kit, delay, r = 4 }: { p: Pt; kit: SceneKit; delay: number; r?: number }) => (
  <circle className="il-pop il-accf il-ring" style={kit.at(delay, 280)} cx={p.x} cy={p.y} r={r} />
);

// ---------------------------------------------------------------------------------------------------------------
// Getting started: a path of steps that light up, rising to a flag
// ---------------------------------------------------------------------------------------------------------------

const PATH_START: Pt = { x: 10, y: 130 };
const PATH_NODES: readonly Pt[] = [{ x: 30, y: 121 }, { x: 70, y: 110 }, { x: 110, y: 95 }, { x: 148, y: 77 }, { x: 182, y: 58 }];
const FLAG: Pt = { x: 206, y: 43 };
const PATH_SEGMENTS: readonly Cubic[] = smoothSegments([PATH_START, ...PATH_NODES, FLAG]);

/** Entrance timing of the Getting started path for `lit` steps: the thread, each step and the flag. */
export function pathTiming(lit: number): { thread: [number, number] | null; steps: number[]; current: number | null; flag: number | null } {
  const segments = lit >= PATH_STEPS ? PATH_SEGMENTS.length : lit;
  if (!segments) return { thread: null, steps: [], current: 260, flag: null };
  const duration = 140 + 110 * segments;
  const start = 220;
  // A step lights a moment before the thread reaches it, so the pop lands as the line arrives.
  const steps = Array.from({ length: Math.min(lit, PATH_STEPS) }, (_, i) => Math.round(start + (duration * (i + 1)) / segments - 140));
  return {
    thread: [start, duration],
    steps,
    current: lit < PATH_STEPS ? start + duration - 80 : null,
    flag: lit >= PATH_STEPS ? start + duration - 100 : null,
  };
}

const gettingStarted: Scene = (kit) => {
  const timing = pathTiming(kit.lit);
  const done = kit.lit >= PATH_STEPS;
  const lit = PATH_SEGMENTS.slice(0, done ? PATH_SEGMENTS.length : kit.lit);
  return (
    <>
      <path className="il-fade il-slot" style={kit.at(40, 400)} d={pathOf(PATH_SEGMENTS)} />
      <g className="il-rise" style={kit.at(160, 440)}>
        <ellipse className="il-shade" cx={FLAG.x} cy={FLAG.y + 2} rx={8} ry={2.5} />
        <path className="il-ink" d={`M${FLAG.x} ${FLAG.y + 1} V${FLAG.y - 29}`} />
        <path className={done ? 'il-paper il-ink' : 'il-paper il-field'} d={`M${FLAG.x} ${FLAG.y - 28} H${FLAG.x + 21} L${FLAG.x + 16} ${FLAG.y - 21.5} L${FLAG.x + 21} ${FLAG.y - 15} H${FLAG.x} Z`} />
      </g>
      {timing.flag !== null ? (
        <path className="il-pop il-accf" style={kit.at(timing.flag, 260)} d={`M${FLAG.x + 1} ${FLAG.y - 27} H${FLAG.x + 19} L${FLAG.x + 14.5} ${FLAG.y - 21.5} L${FLAG.x + 19} ${FLAG.y - 16} H${FLAG.x + 1} Z`} />
      ) : null}
      <g className="il-rise" style={kit.at(80, 420)}>
        {PATH_NODES.map((p, i) => <circle key={i} className="il-paper il-field" cx={p.x} cy={p.y} r={7.5} />)}
      </g>
      {timing.thread ? <path className="il-draw il-thread" pathLength={1} style={kit.at(...timing.thread)} d={pathOf(lit)} /> : null}
      {timing.steps.map((delay, i) => (
        <g key={i} className="il-pop" style={kit.at(delay, 260)} data-step="lit">
          <circle className="il-accf il-ring" cx={PATH_NODES[i].x} cy={PATH_NODES[i].y} r={9} />
          <path className="il-on il-bold" d={tick(PATH_NODES[i].x, PATH_NODES[i].y)} />
        </g>
      ))}
      {timing.current !== null ? (
        <g className="il-pop" style={kit.at(timing.current, 300)} data-step="current">
          <circle className="il-wash il-acc" cx={PATH_NODES[kit.lit].x} cy={PATH_NODES[kit.lit].y} r={9} />
          <circle className="il-accf" cx={PATH_NODES[kit.lit].x} cy={PATH_NODES[kit.lit].y} r={3} />
        </g>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// No management systems yet: four empty tiles, the thread reaches the first, which waits for a plus
// ---------------------------------------------------------------------------------------------------------------

const noSystems: Scene = (kit) => {
  const loop = arcArrow(142, 102, 8, -140, 170);
  const cogTeeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const f = (n: number) => Math.round(n * 100) / 100;
    return `M${f(92 + 8.4 * Math.cos(a))} ${f(102 + 8.4 * Math.sin(a))} L${f(92 + 11 * Math.cos(a))} ${f(102 + 11 * Math.sin(a))}`;
  }).join(' ');
  return (
    <>
      <Ground cx={117} cy={134} rx={50} kit={kit} />
      <g className="il-rise" style={kit.at(60, 460)}>
        <rect className="il-paper il-slot" x={122} y={32} width={40} height={40} rx={8} />
        <path className="il-field" d="M142 41 L151 45 V52 C151 58 147 62 142 64 C137 62 133 58 133 52 V45 Z" />
      </g>
      <g className="il-rise" style={kit.at(120, 460)}>
        <rect className="il-paper il-slot" x={72} y={82} width={40} height={40} rx={8} />
        <circle className="il-field" cx={92} cy={102} r={5.6} />
        <path className="il-field" d={cogTeeth} />
      </g>
      <g className="il-rise" style={kit.at(180, 460)}>
        <rect className="il-paper il-slot" x={122} y={82} width={40} height={40} rx={8} />
        <path className="il-field" d={loop.arc} />
        <path className="il-field" d={loop.head} />
      </g>
      <g className="il-pop" style={kit.at(200, 420)}>
        <rect className="il-wash il-acc" x={72} y={32} width={40} height={40} rx={8} />
      </g>
      <path className="il-draw il-thread" pathLength={1} style={kit.at(300, 500)} d="M8 98 C36 98 44 52 70 52" />
      <path className="il-draw il-acc il-bold" pathLength={1} style={kit.at(620, 340)} d="M92 44 V60 M84 52 H100" />
      <Node p={{ x: 71.5, y: 52 }} kit={kit} delay={760} />
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// No documents yet: an empty page with a plus, two ghost pages behind it, the thread arrives at its edge
// ---------------------------------------------------------------------------------------------------------------

const noDocuments: Scene = (kit) => {
  const front = page(88, 38, 64, 82, 14);
  const ghost = page(0, 0, 58, 74, 12);
  return (
    <>
      <Ground cx={120} cy={131} rx={44} kit={kit} />
      <g className="il-rise" style={kit.at(40, 460)}>
        <g className="il-ghost" transform="translate(70 44) rotate(-9 29 37)">
          <path className="il-paper2 il-field il-thin" d={ghost.body} />
        </g>
      </g>
      <g className="il-rise" style={kit.at(100, 460)}>
        <g className="il-ghost" transform="translate(112 42) rotate(8 29 37)">
          <path className="il-paper2 il-field il-thin" d={ghost.body} />
        </g>
      </g>
      <g className="il-rise" style={kit.at(180, 480)}>
        <path className="il-paper il-ink" d={front.body} />
        <path className="il-ink" d={front.fold} />
        <path className="il-line" d="M100 104 H128 M100 111 H118" />
      </g>
      <path className="il-draw il-thread" pathLength={1} style={kit.at(320, 500)} d="M8 108 C40 108 56 96 86 96" />
      <g className="il-pop" style={kit.at(640, 340)}>
        <circle className="il-wash il-acc" cx={120} cy={74} r={13} />
        <path className="il-acc il-bold" d="M120 67.5 V80.5 M113.5 74 H126.5" />
      </g>
      <Node p={{ x: 87.5, y: 96 }} kit={kit} delay={780} />
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// No evidence yet: an empty file drops into an open folder, the thread reaches the file
// ---------------------------------------------------------------------------------------------------------------

const noEvidence: Scene = (kit) => {
  const file = page(103, 34, 34, 60, 10, 5);
  return (
    <>
      <Ground cx={120} cy={132} rx={52} kit={kit} />
      <g className="il-rise" style={kit.at(40, 460)}>
        <path className="il-paper2 il-ink" d="M81 60 H99 A3 3 0 0 1 101.5 61.3 L105 66 H157 A5 5 0 0 1 162 71 V117 A5 5 0 0 1 157 122 H83 A5 5 0 0 1 78 117 V63 A3 3 0 0 1 81 60 Z" />
      </g>
      <g className="il-drop" style={kit.at(180, 520)}>
        <path className="il-paper il-slot" d={file.body} />
        <path className="il-field" d={file.fold} />
      </g>
      <g className="il-rise" style={kit.at(120, 460)}>
        <path className="il-paper il-ink" d="M71.5 88 H168.5 A3 3 0 0 1 171.4 91.7 L165.1 118.3 A5 5 0 0 1 160.2 122 H79.8 A5 5 0 0 1 74.9 118.3 L68.6 91.7 A3 3 0 0 1 71.5 88 Z" />
        <path className="il-line" d="M108 106 H132" />
      </g>
      <path className="il-draw il-thread" pathLength={1} style={kit.at(340, 480)} d="M8 66 C38 66 70 50 101 50" />
      <path className="il-draw il-acc il-bold" pathLength={1} style={kit.at(600, 360)} d="M120 46 V68 M113.5 61.5 L120 68 L126.5 61.5" />
      <Node p={{ x: 102.5, y: 50 }} kit={kit} delay={780} />
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// No findings: a clipboard with every check ticked, and a magnifying glass that found nothing
// ---------------------------------------------------------------------------------------------------------------

const ROWS = [58, 80, 102] as const;
const ROW_LINES = [26, 19, 23] as const;

const noFindings: Scene = (kit) => (
  <>
    <Ground cx={122} cy={134} rx={46} kit={kit} />
    <g className="il-rise" style={kit.at(40, 480)}>
      <rect className="il-paper il-ink" x={82} y={30} width={68} height={96} rx={8} />
      <rect className="il-paper2 il-ink" x={102} y={24} width={28} height={13} rx={4} />
      {ROWS.map((y, i) => <path key={y} className="il-line" d={`M112 ${y} H${112 + ROW_LINES[i]}`} />)}
    </g>
    {ROWS.map((y, i) => (
      <g key={y}>
        <circle className="il-pop il-okbg" style={kit.at(260 + i * 100, 280)} cx={98} cy={y} r={6.5} />
        <path className="il-draw il-ok il-bold" pathLength={1} style={kit.at(330 + i * 100, 300)} d={tick(98, y)} />
      </g>
    ))}
    <g className="il-slide" style={kit.at(520, 540)}>
      <path className="il-acc il-heavy" d="M167 115 L178 126" />
      <circle className="il-paper il-acc il-bold" cx={156} cy={104} r={15} />
      <path className="il-line" d="M147.5 100 A9.5 9.5 0 0 1 153 95" />
    </g>
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// All done: the thread runs through six lit nodes into a seal with a tick
// ---------------------------------------------------------------------------------------------------------------

const CHAIN_NODES: readonly Pt[] = [{ x: 26, y: 114 }, { x: 57, y: 104 }, { x: 88, y: 108 }, { x: 119, y: 96 }, { x: 150, y: 98 }, { x: 180, y: 84 }];
const SEAL: Pt = { x: 208, y: 56 };
const CHAIN_SEGMENTS: readonly Cubic[] = smoothSegments([{ x: 6, y: 120 }, ...CHAIN_NODES, SEAL]);
const THREAD_ALL: [number, number] = [100, 680];

const allDone: Scene = (kit) => (
  <>
    <path className="il-draw il-thread" pathLength={1} style={kit.at(...THREAD_ALL)} d={pathOf(CHAIN_SEGMENTS)} />
    {CHAIN_NODES.map((p, i) => (
      <g key={i} className="il-pop" style={kit.at(Math.round(THREAD_ALL[0] + (THREAD_ALL[1] * (i + 1)) / CHAIN_SEGMENTS.length - 90), 260)}>
        <circle className="il-accf il-ring" cx={p.x} cy={p.y} r={8} />
        <path className="il-on il-bold" d={tick(p.x, p.y)} />
      </g>
    ))}
    <g className="il-rise" style={kit.at(700, 320)}>
      <path className="il-okbg il-ok" d="M200 68 L195 88 L202 85 L206 91 L209 72 Z" />
      <path className="il-okbg il-ok" d="M216 68 L221 88 L214 85 L210 91 L207 72 Z" />
    </g>
    <g className="il-pop" style={kit.at(800, 380)}>
      <path className="il-okbg il-ok" d={rosette(SEAL.x, SEAL.y, 20, 17, 12)} />
      <path className="il-ok il-heavy" d={`M${SEAL.x - 7} ${SEAL.y + 0.5} L${SEAL.x - 2} ${SEAL.y + 5.5} L${SEAL.x + 8} ${SEAL.y - 5}`} />
    </g>
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// Something went wrong: a page panel whose thread snapped, with a warning sign on its corner
// ---------------------------------------------------------------------------------------------------------------

const BROKEN_LEFT: Cubic = { p0: { x: 6, y: 112 }, c1: { x: 40, y: 112 }, c2: { x: 72, y: 98 }, p1: { x: 111, y: 98 } };
const BROKEN_RIGHT: Cubic = { p0: { x: 234, y: 112 }, c1: { x: 200, y: 112 }, c2: { x: 168, y: 93 }, p1: { x: 129, y: 93 } };

const errorScene: Scene = (kit) => (
  <>
    <Ground cx={120} cy={134} rx={54} kit={kit} />
    <g className="il-rise" style={kit.at(40, 480)}>
      <rect className="il-paper il-ink" x={62} y={30} width={116} height={94} rx={8} />
      <path className="il-line" d="M62 46 H178" />
      <path className="il-line" d="M76 60 H128 M76 69 H110" />
    </g>
    <g className="il-fade" style={kit.at(120, 360)}>
      {[72, 79, 86].map((x) => <circle key={x} className="il-fieldf" cx={x} cy={38} r={1.8} />)}
    </g>
    <path className="il-draw il-ink il-bold" pathLength={1} style={kit.at(160, 480)} d={pathOf([BROKEN_LEFT])} />
    <path className="il-draw il-ink il-bold" pathLength={1} style={kit.at(160, 480)} d={pathOf([BROKEN_RIGHT])} />
    {[cubicAt(BROKEN_LEFT, 0.3), cubicAt(BROKEN_RIGHT, 0.3)].map((p, i) => (
      <circle key={i} className="il-pop il-paper il-ink il-bold" style={kit.at(300, 280)} cx={Math.round(p.x * 10) / 10} cy={Math.round(p.y * 10) / 10} r={5.5} />
    ))}
    <path className="il-fade il-bad il-bold" style={kit.at(620, 300)} d="M116 88 L113.5 83.5 M121 86.5 V81.5 M126 85.5 L128.5 81 M114 104 L111.5 108.5 M119 106 V111 M124 103 L126.5 107.5" />
    <g className="il-pop" style={kit.at(700, 400)}>
      <circle className="il-badbg il-bad il-bold" cx={178} cy={31} r={13} />
      <path className="il-bad il-heavy" d="M178 24.5 V33" />
      <circle className="il-badf" cx={178} cy={38} r={1.8} />
    </g>
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// Connection lost: the cable is pulled out of its socket, with a cloud that cannot be reached above the gap
// ---------------------------------------------------------------------------------------------------------------

const offline: Scene = (kit) => (
  <>
    <Ground cx={120} cy={128} rx={58} kit={kit} />
    <path className="il-draw il-ink il-bold" pathLength={1} style={kit.at(60, 460)} d="M6 114 C30 114 40 96 61 96" />
    <path className="il-draw il-ink il-bold" pathLength={1} style={kit.at(60, 460)} d="M234 114 C210 114 190 96 168 96" />
    {/* The plug and the socket fade in with their cables, then pull apart. */}
    <g className="il-fade" style={kit.at(60, 300)}>
      <g className="il-slide-l" style={kit.at(300, 440)}>
        <path className="il-ink il-heavy" d="M85 90 H96 M85 102 H96" />
        <rect className="il-paper il-ink" x={61} y={84} width={24} height={24} rx={5} />
        <path className="il-line" d="M69 90 V102" />
      </g>
    </g>
    <g className="il-fade" style={kit.at(60, 300)}>
      <g className="il-slide-r" style={kit.at(300, 440)}>
        <rect className="il-paper il-ink" x={144} y={84} width={24} height={24} rx={5} />
        <path className="il-ink il-heavy" d="M149 90 H155 M149 102 H155" />
        <path className="il-line" d="M161 90 V102" />
      </g>
    </g>
    <path className="il-fade il-slot" style={kit.at(600, 400)} d="M100 96 Q120 110 140 96" />
    <g className="il-pop" style={kit.at(700, 380)}>
      <circle className="il-warnbg il-warn il-bold" cx={120} cy={46} r={17} />
      <path className="il-warn il-bold" d="M111.5 52 H128.5 A5 5 0 0 0 128 42 A7.5 7.5 0 0 0 114 40.5 A6 6 0 0 0 111.5 52 Z M109.5 35 L130.5 56" />
    </g>
  </>
);

/** The drawing of each scene. */
export const SCENE_DRAWINGS: Readonly<Record<SceneName, Scene>> = {
  'getting-started': gettingStarted,
  'no-systems': noSystems,
  'no-documents': noDocuments,
  'no-evidence': noEvidence,
  'no-findings': noFindings,
  'all-done': allDone,
  error: errorScene,
  offline,
};

/** True for a name of SCENES (for scene names that come from data). */
export function isSceneName(name: unknown): name is SceneName {
  return typeof name === 'string' && (SCENES as readonly string[]).includes(name);
}
