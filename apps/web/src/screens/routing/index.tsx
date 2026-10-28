// Routing rules (MILESTONE-2 M2-09): which repository and storage mode a new file of a system goes to, in the
// Administration group. Visible with `storage.repository.read` (Tenant Admin, Storage Admin, MS Managers); "Add rule"
// with `storage.routing.manage` (Tenant Admin, Storage Admin).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 21v-4M3 6l3-3 3 3M15 18l3 3 3-3';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'routing',
  path: '/admin/storage/routing',
  group: 'admin',
  order: 34,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'storage.repository.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan('storage.routing.manage')
    ? [{ label: [TEXT.addRule[0], TEXT.addRule[1]], icon: PLUS, primary: true, run: (c) => c.go('routing', { params: { add: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
