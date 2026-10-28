// Pending approvals (MILESTONE-2 M2-10): role grants and routing changes waiting for a second approval, in the
// Administration group, with a sidebar badge of the number waiting (badge.ts). Visible with `user.manage` (Tenant
// Admin) or `storage.routing.manage` (Tenant Admin, Storage Admin).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { APPROVAL_PERMS, badgeCount } from './badge';
import { TEXT } from './text';

const ICON = 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9';

const screen: ScreenDef = {
  id: 'approvals',
  path: '/admin/users/approvals',
  group: 'admin',
  order: 42,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: APPROVAL_PERMS,
  Component: lazy(() => import('./Screen')),
  count: () => badgeCount(),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
