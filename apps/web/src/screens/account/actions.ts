// Shell slot of the My account screen (MILESTONE-2 C.5, M2-16): the "My account" entry of the top bar, next to the
// notification bell, for every signed-in session (API) and every sample persona.
import type { ScreenActions } from '../types';
import { AccountEntry } from './Entry';

export const topbarItems: ScreenActions['topbarItems'] = [
  { id: 'account-entry', order: 20, Component: AccountEntry, visible: (ctx) => ctx.mode === 'sample' || Boolean(ctx.me) },
];
