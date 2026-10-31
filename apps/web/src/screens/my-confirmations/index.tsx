// Policies to confirm (MILESTONE-3 M3-05, D.7, `/my-confirmations`): the session person's open and recent read
// confirmations with "Open document", the statement and "Confirm" (H.7: open first, a checkbox and a button). In the My
// Tasks group of the sidebar (C.2) after My Tasks, with the number of open confirmations as its badge, for every member
// with a business role in the selected system (`ms.read`, as "My account"). The banner of the host layer that counts the
// open confirmations opens it, as does the page action of My Tasks while confirmations are open (actions.ts), and the
// title of each confirmation task and notification names it.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { ICON, SCREEN_ID } from './model';
import { openConfirmationCount } from './store';
import { TEXT } from './text';

const screen: ScreenDef = {
  id: SCREEN_ID,
  path: '/my-confirmations',
  group: 'tasks',
  order: 20,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'owner', 'auditor', 'top'],
  perm: 'ms.read',
  Component: lazy(() => import('./Screen')),
  count: (ctx) => openConfirmationCount(ctx),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
