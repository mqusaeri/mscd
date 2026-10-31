// Retention and disposal (MILESTONE-3 M3-06, C.2, D.8): the retention periods of a management system, the disposal
// review when a period ends, legal holds and the disposal register, in the Implementation group. Opened by holders of
// `retention.manage` (Management System Managers) or `retention.approve` (also Programme Owners).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** An archive box with a clock: records kept for a period. */
const ICON = 'M3 7h18M5 7v12a2 2 0 0 0 2 2h4M19 7V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v2M10 11h4M17 15v2l1.5 1.5M21 17a4 4 0 1 1-8 0 4 4 0 0 1 8 0z';

const screen: ScreenDef = {
  id: 'retention',
  path: '/ms/:ms/retention',
  group: 'impl',
  order: 55,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: ['retention.manage', 'retention.approve'],
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
