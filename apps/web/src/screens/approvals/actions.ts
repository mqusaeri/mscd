// Shell slot of Pending approvals (MILESTONE-2 C.5, M2-10): a layer item without any output that keeps the sidebar
// badge of the screen current (badge.ts).
import { BadgeLoader } from './BadgeLoader';
import { APPROVAL_PERMS } from './badge';
import type { SlotItem } from '../types';

export const layerItems: SlotItem[] = [
  { id: 'approvals-badge', order: 90, Component: BadgeLoader, visible: (ctx) => Boolean(ctx.org) && ctx.orgCan([...APPROVAL_PERMS]) },
];
