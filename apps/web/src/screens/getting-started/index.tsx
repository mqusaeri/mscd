// Getting started (MILESTONE-2 M2-16): the onboarding checklist, first in the Administration group, with `ms.admin`
// (Tenant Admin). A Tenant Admin without a business role lands here (C.3 administration landing).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M4 20V5M4 5h11l-1.5 3.5L15 12H4M9 16l2 2 4-4';

const screen: ScreenDef = {
  id: 'getting-started',
  path: '/admin/getting-started',
  group: 'admin',
  order: 5,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'ms.admin',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
