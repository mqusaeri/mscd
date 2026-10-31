// Page actions "Open work totals" of Chain stages (`chain`) and the system Overview (`m1overview`) (MILESTONE-3 M3-08,
// D.10, C.5 `extraPageActions`): they open the Open work totals screen for whoever holds `audit.pending.aggregate` in
// the selected system (Top Management, the Programme Owner and the Management System Manager, F.6).
//
// API builds only (C.1): `e2e/shell.spec.js` checks the exact page actions of the generated views in the sample build,
// so the sample build reaches the screen through its address instead.
import type { ExtraPageAction, HostContext } from '../types';
import { ICON, SCREEN_ID, TOTALS_PERM } from './model';
import { TEXT } from './text';

/** Whether the session may open the totals of the selected system from a page action (API builds only). */
export function mayOpenTotals(ctx: HostContext): boolean {
  return ctx.mode === 'api' && Boolean(ctx.msObj) && ctx.can(ctx.msObj!.id, TOTALS_PERM);
}

function openTotals(screen: 'chain' | 'm1overview', id: string): ExtraPageAction {
  return {
    screen,
    id,
    label: [TEXT.openAction[0], TEXT.openAction[1]],
    icon: ICON,
    visible: mayOpenTotals,
    run: (ctx: HostContext) => ctx.go(SCREEN_ID),
  };
}

export const extraPageActions: ExtraPageAction[] = [
  openTotals('chain', 'chain.pendingTotals'),
  openTotals('m1overview', 'm1overview.pendingTotals'),
];
