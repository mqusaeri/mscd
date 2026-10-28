// Organisation (MILESTONE-2 M2-16): the settings of the organisation in the Administration group, with
// `org.settings.manage` (Tenant Admin).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M4 21V7l8-4 8 4v14M4 21h16M9 21v-5h6v5M8 10h.01M12 10h.01M16 10h.01M8 13h.01M16 13h.01';

const screen: ScreenDef = {
  id: 'organization',
  path: '/admin/organization',
  group: 'admin',
  order: 28,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'org.settings.manage',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
