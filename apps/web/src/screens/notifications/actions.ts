// Shell slot of the notifications (MILESTONE-2 C.5, M2-16): the bell of the top bar. It shows in the sample build and
// for every API session in an organisation (notifications belong to the current organisation; a platform operator
// without a membership has none).
import type { ScreenActions } from '../types';
import { NotificationBell } from './Bell';

export const topbarItems: ScreenActions['topbarItems'] = [
  { id: 'notifications-bell', order: 10, Component: NotificationBell, visible: (ctx) => ctx.mode === 'sample' || Boolean(ctx.me?.org) },
];
