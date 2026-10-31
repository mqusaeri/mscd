// Open work totals (MILESTONE-3 M3-08, D.10): open and overdue counts per chain stage and business role of a
// management system, without names (product decision 2), for Top Management, the Programme Owner and the Management
// System Manager (`audit.pending.aggregate`, F.6). In the Audit group without a sidebar entry (D3-02): the page actions
// "Open work totals" of Chain stages and the system Overview lead to it in API builds (actions.ts, C.1), and the sample
// build opens it by its address (`?screen=pending-totals&persona=top`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { ICON, SCREEN_ID, TOTALS_PERM } from './model';
import { TEXT } from './text';

const screen: ScreenDef = {
  id: SCREEN_ID,
  path: '/ms/:ms/pending-totals',
  group: 'audit',
  order: 25,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['top', 'manager'],
  perm: TOTALS_PERM,
  nav: false,
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
