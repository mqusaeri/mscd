// Shell slot of "Policies to confirm" (MILESTONE-3 M3-05, C.5, D.7): the banner in the host layer that counts the
// session person's open confirmations, in both builds (the sample personas start with none, C.6).
import type { ScreenActions } from '../types';
import { ConfirmationBanner } from './Banner';

export const layerItems: ScreenActions['layerItems'] = [
  { id: 'my-confirmations.banner', order: 12, Component: ConfirmationBanner, visible: (ctx) => Boolean(ctx.org) && Boolean(ctx.msObj) },
];
