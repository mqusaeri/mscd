// Management systems (MILESTONE-2 M2-09): the systems of the organisation in the Administration group, with
// `ms.admin` (Tenant Admin). "New management system" creates a system on an installed pack (`admin.ms.create`, which
// also needs `pack.activate`, held by the same role).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 16h7M16.5 13v7';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'systems',
  path: '/admin/systems',
  group: 'admin',
  order: 32,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'ms.admin',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan(['ms.admin']) && ctx.orgCan('pack.activate')
    ? [{ label: [TEXT.newSystem[0], TEXT.newSystem[1]], icon: PLUS, primary: true, run: (c) => c.go('systems', { params: { create: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
