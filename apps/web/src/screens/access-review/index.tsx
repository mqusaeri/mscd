// Access review of this system (MILESTONE-3 M3-07, C.2, D.9): the selected system's part of the periodic access
// review, in the Audit group, for its Management System Managers and Programme Owners (`access_review.decide`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** A person with a check: the access of people reviewed. */
const ICON = 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 9.5-4.9M15 17l2 2 4-4';

const screen: ScreenDef = {
  id: 'access-review',
  path: '/ms/:ms/access-review',
  group: 'audit',
  order: 75,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: 'access_review.decide',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
