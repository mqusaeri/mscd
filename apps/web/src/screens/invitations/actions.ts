// Shell slot of the invitations (MILESTONE-2 C.5, M2-16): the banner in the host layer while invitations of other
// organisations wait for the session user (API builds; the sample has no pending memberships).
import type { ScreenActions } from '../types';
import { InvitationBanner } from './Banner';
import { pendingOf } from './model';

export const layerItems: ScreenActions['layerItems'] = [
  { id: 'invitations-banner', order: 10, Component: InvitationBanner, visible: (ctx) => ctx.mode === 'api' && pendingOf(ctx).length > 0 },
];
