// Extensions of the Management systems package (MILESTONE-2 C.5, M2-09): the page action "Edition transition" of the
// Framework library screen (`fw`) for MS Managers (`ms.transition`), which opens the transition drawer over that
// screen (store.ts, layer.tsx).
//
// The action shows in API builds only. The sample build's Framework library keeps its single Milestone 1 page action
// (its specs pin it, R-15), and its sample already shows the ISO 9001 system in transition with the Transition button
// of the framework row.
import type { HostContext, ScreenActions } from '../types';
import { TransitionLayer } from './layer';
import { requestTransition } from './store';
import { TEXT } from './text';

const ICON = 'M4 7h13l-3-3M20 17H7l3 3';

/** Whether the session may move one of its systems to another edition. */
export function mayTransition(ctx: HostContext): boolean {
  return ctx.mode === 'api' && (ctx.D?.MS ?? []).some((m) => ctx.can(m.id, 'ms.transition'));
}

export const extraPageActions: ScreenActions['extraPageActions'] = [
  {
    screen: 'fw',
    id: 'fw.transition',
    label: [TEXT.transition[0], TEXT.transition[1]],
    icon: ICON,
    visible: mayTransition,
    run: () => requestTransition(Date.now()),
  },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'systems-transition', order: 20, Component: TransitionLayer }];
