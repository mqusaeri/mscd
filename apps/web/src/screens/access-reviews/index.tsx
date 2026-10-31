// Access reviews (MILESTONE-3 M3-07, C.2, D.9): the periodic access review of the organisation, in the Administration
// group, for the Tenant Admins (`access_review.manage`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** A shield with a check and a clock hand: access checked on a schedule. */
const ICON = 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4';

const screen: ScreenDef = {
  id: 'access-reviews',
  path: '/admin/access-reviews',
  group: 'admin',
  order: 45,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'access_review.manage',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
