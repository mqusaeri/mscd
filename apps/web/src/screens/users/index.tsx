// People and roles (MILESTONE-2 M2-10): the members of the organisation, their administration roles and their roles
// per management system, in the Administration group. Visible with `user.manage` (Tenant Admin). It sits after
// Licence, so an administrator without a business role still lands on Licence until "Getting started" exists (C.3).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75';

const screen: ScreenDef = {
  id: 'users',
  path: '/admin/users',
  group: 'admin',
  order: 40,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'user.manage',
  Component: lazy(() => import('./Screen')),
  pageActions: () => [
    { label: [TEXT.invite[0], TEXT.invite[1]], icon: 'M12 5v14M5 12h14', primary: true, run: (c) => c.go('users', { params: { invite: Date.now() } }) },
    { label: [TEXT.export[0], TEXT.export[1]], icon: 'M12 3v12M7 10l5 5 5-5M4 19h16', run: (c) => c.go('users', { params: { exportAt: Date.now() } }) },
  ],
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3, TEXT.teraHow4].map((h) => [h[0], h[1]]),
  },
};

export default screen;
