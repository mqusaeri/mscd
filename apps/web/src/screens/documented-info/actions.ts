// Shell slot of Required documented information (MILESTONE-2 C.5, M2-12): a layer item without any output that keeps
// the sidebar badge of the screen (the number of missing items) current (badge.ts).
import type { SlotItem } from '../types';
import { BadgeLoader } from './BadgeLoader';

export const layerItems: SlotItem[] = [
  {
    id: 'documented-info-badge',
    order: 91,
    Component: BadgeLoader,
    visible: (ctx) => Boolean(ctx.msObj) && (ctx.mode === 'sample' || ctx.can(ctx.msObj!.id, 'ms.read')),
  },
];
