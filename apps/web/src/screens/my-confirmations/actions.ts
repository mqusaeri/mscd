// Extension points of "Policies to confirm" (MILESTONE-3 M3-05, C.5, D.7), in both builds (the sample personas start
// with none open, C.6):
// - the banner in the host layer that counts the session person's open confirmations (and keeps the sidebar badge);
// - the page action "Policies to confirm" of My Tasks while confirmations are open, the link from the tasks the
//   screen completes (`tasks.complete` refuses them, D.2).
import type { ExtraPageAction, HostContext, ScreenActions } from '../types';
import { ConfirmationBanner } from './Banner';
import { ICON, SCREEN_ID } from './model';
import { openConfirmationCount } from './store';
import { TEXT } from './text';

export const layerItems: ScreenActions['layerItems'] = [
  { id: 'my-confirmations.banner', order: 12, Component: ConfirmationBanner, visible: (ctx) => Boolean(ctx.org) && Boolean(ctx.msObj) },
];

/** The page action shows on My Tasks while the session person has open confirmations in the current organisation. */
export function hasOpenConfirmations(ctx: HostContext): boolean {
  return Boolean(ctx.org) && Boolean(ctx.msObj) && openConfirmationCount(ctx) > 0;
}

export const extraPageActions: ExtraPageAction[] = [
  {
    screen: 'mytasks',
    id: 'mytasks.policiesToConfirm',
    label: [TEXT.title[0], TEXT.title[1]],
    icon: ICON,
    primary: true,
    visible: hasOpenConfirmations,
    run: (ctx) => ctx.go(SCREEN_ID),
  },
];
