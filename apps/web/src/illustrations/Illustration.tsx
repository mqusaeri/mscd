// The illustration component (MILESTONE-2 MOT-03, section L): one scene of scenes.tsx on its dotted stage, at a size,
// with a text alternative in the interface language. It plays a short entrance once when it mounts (every step ends
// within ENTRANCE_MS), then stays still; with `prefers-reduced-motion: reduce` or `still` it shows the final frame at
// once. Nothing is hidden at rest: the entrance hides an element only while it waits for its own animation.
import { useId } from 'react';
import type { Lang } from '../screens/types';
import { fillText, textOf, useLang } from '../screens/ui/text';
import type { TextLike } from '../screens/ui/text';
import { litSteps } from './geometry';
import { PATH_STEPS, SCENE_DRAWINGS, STAGE, isSceneName } from './scenes';
import type { SceneKit, SceneName } from './scenes';
import { SCENE_TEXT } from './text';
import './illustrations.css';

/** Widths of the named sizes in CSS pixels; the height keeps the 3 by 2 stage. */
export const SIZES = { sm: 128, md: 192, lg: 288 } as const;
export type IllustrationSize = keyof typeof SIZES | number;

/** The share of the Getting started checklist the scene shows as done when no progress is given (3 of 5 steps). */
export const DEFAULT_PROGRESS = 0.6;

export interface IllustrationProps {
  /** The scene to show. */
  scene: SceneName;
  /** `sm` (128px wide), `md` (192px, the default), `lg` (288px) or a width in pixels (48 to 640). */
  size?: IllustrationSize;
  /** A text alternative of your own, in place of the scene's. */
  label?: TextLike;
  /** Hides the picture from assistive technology, for a place where the text next to it says everything. */
  decorative?: boolean;
  /** Shows the final frame at once, without the entrance. */
  still?: boolean;
  /** Getting started only: the share of the checklist that is done, 0 to 1 (done divided by total). */
  progress?: number;
  /** The language of the text alternative; the host screen's language by default. */
  lang?: Lang;
  className?: string;
}

/** The width in pixels of a size; unknown or out of range values fall back to `md` or the nearest limit. */
export function widthOf(size: IllustrationSize | undefined): number {
  if (typeof size === 'number') return Number.isFinite(size) ? Math.round(Math.min(640, Math.max(48, size))) : SIZES.md;
  return SIZES[size ?? 'md'] ?? SIZES.md;
}

/** The text alternative of a scene in a language (with the lit steps of the Getting started path). */
export function sceneLabel(scene: SceneName, lang: Lang, progress: number = DEFAULT_PROGRESS): string {
  const done = scene === 'getting-started' ? litSteps(progress, PATH_STEPS) : 0;
  return fillText(SCENE_TEXT[scene].alt, { done, steps: PATH_STEPS }, lang);
}

/** One scene of the library. Renders nothing for a name that is not a scene. */
export function Illustration({ scene, size = 'md', label, decorative = false, still = false, progress = DEFAULT_PROGRESS, lang, className }: IllustrationProps) {
  const hostLang = useLang();
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  if (!isSceneName(scene)) return null;
  const language: Lang = lang ?? hostLang;
  const width = widthOf(size);
  const height = Math.round((width * STAGE.height) / STAGE.width);
  const kit: SceneKit = {
    id: (name) => `il${uid}-${name}`,
    at: (delay, duration) => ({ animationDelay: `${delay}ms`, animationDuration: `${duration}ms` }),
    lit: scene === 'getting-started' ? litSteps(progress, PATH_STEPS) : 0,
  };
  const alt = label !== undefined && label !== null && textOf(label, language).trim() ? textOf(label, language) : sceneLabel(scene, language, progress);
  const dots = kit.id('dots');
  const fade = kit.id('fade');
  const mask = kit.id('mask');
  return (
    <svg
      className={['il', still ? 'il-still' : null, className].filter(Boolean).join(' ')}
      data-scene={scene}
      viewBox={`0 0 ${STAGE.width} ${STAGE.height}`}
      width={width}
      height={height}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : alt}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <defs>
        <pattern id={dots} width={12} height={12} patternUnits="userSpaceOnUse">
          <circle className="il-dot" cx={6} cy={6} r={1} />
        </pattern>
        <radialGradient id={fade} cx={120} cy={82} r={124} gradientUnits="userSpaceOnUse" gradientTransform="translate(120 82) scale(1 0.64) translate(-120 -82)">
          <stop offset={0} stopColor="white" stopOpacity={1} />
          <stop offset={0.55} stopColor="white" stopOpacity={0.6} />
          <stop offset={1} stopColor="white" stopOpacity={0} />
        </radialGradient>
        <mask id={mask}>
          <rect width={STAGE.width} height={STAGE.height} fill={`url(#${fade})`} />
        </mask>
      </defs>
      <g className="il-fade il-plate" style={kit.at(0, 360)}>
        <rect width={STAGE.width} height={STAGE.height} fill={`url(#${dots})`} mask={`url(#${mask})`} />
      </g>
      {SCENE_DRAWINGS[scene](kit)}
    </svg>
  );
}
