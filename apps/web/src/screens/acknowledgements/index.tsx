// Policy read confirmations (MILESTONE-3 M3-05, D.7, `/ms/:ms/acknowledgements`): the confirmation requests of the
// documents of the selected system with their totals, the person list for the Management System Manager and the
// Programme Owner (`audit.pending.all`), totals for Top Management (`audit.pending.aggregate`), and the requests by hand,
// reminders, the CSV and "Close and file as evidence" of the Management System Manager (`acknowledgement.manage`). In
// the Implementation group; the Document register reaches it through the page action "Read confirmations" in API
// builds (actions.ts, C.1).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { ICON, MANAGE_PERM, SCREEN_ID, SCREEN_PERMS } from './model';
import { TEXT } from './text';

const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: SCREEN_ID,
  path: '/ms/:ms/acknowledgements',
  group: 'impl',
  order: 45,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'top'],
  perm: SCREEN_PERMS,
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.msObj && ctx.can(ctx.msObj.id, MANAGE_PERM)
    ? [{ label: [TEXT.ask[0], TEXT.ask[1]], icon: PLUS, primary: true, run: (c) => c.go(SCREEN_ID, { params: { ask: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
