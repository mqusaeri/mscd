// Shell slot of the Registers screen (MILESTONE-2 C.5, M2-13): a layer item without any output that reads the first page
// of the first register when a system opens, for a session that may open the screen (cache.ts, Prefetch.tsx).
import type { HostContext, SlotItem } from '../types';
import screen from './index';
import { RegistersLayer } from './layer';

/** Sample build: the personas the screen lists in `roles` (C.2); the api checks `ms.read` in the selected system. */
export function prefetchVisible(ctx: HostContext): boolean {
  if (!ctx.msObj || ctx.screen === 'registers') return false;
  if (ctx.mode === 'sample') return ctx.role !== null && screen.roles.includes(ctx.role);
  return ctx.can(ctx.msObj.id, 'ms.read');
}

export const layerItems: SlotItem[] = [
  { id: 'registers-prefetch', order: 92, Component: RegistersLayer, visible: prefetchVisible },
];
