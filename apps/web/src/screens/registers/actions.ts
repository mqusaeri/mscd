// Shell slot of the Registers screen (MILESTONE-2 C.5, M2-13): a layer item without any output that reads the first page
// of the first register when a system opens, for a session that may open the screen (cache.ts, Prefetch.tsx).
import type { HostContext, SlotItem } from '../types';
import { RegistersLayer } from './layer';

/** The roles of the screen in the sample build (meta.json); the api checks `ms.read` in the selected system. */
const SAMPLE_ROLES = ['manager', 'owner', 'auditor', 'top'];

export function prefetchVisible(ctx: HostContext): boolean {
  if (!ctx.msObj || ctx.screen === 'registers') return false;
  return ctx.mode === 'sample' ? SAMPLE_ROLES.includes(ctx.role ?? '') : ctx.can(ctx.msObj.id, 'ms.read');
}

export const layerItems: SlotItem[] = [
  { id: 'registers-prefetch', order: 92, Component: RegistersLayer, visible: prefetchVisible },
];
