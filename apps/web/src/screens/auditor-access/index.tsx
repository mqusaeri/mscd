// Auditor access (MILESTONE-2 M2-15): the auditor workspace of a management system in the Audit group. Guest auditor
// grants for the MS Manager (`auditor_access.grant`), evidence packs for everyone who reads the system (`ms.read`).
// The path ends with the screen id (D2-14), so it is `/ms/:ms/audit/auditor-access` where the plan wrote
// `/ms/:ms/audit/access`.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { mayGrant } from './model';
import { TEXT } from './text';

const ICON = 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM4 21v-2a5 5 0 0 1 5-5h3M16 15l2 2 4-4M17 21h-1';

const screen: ScreenDef = {
  id: 'auditor-access',
  path: '/ms/:ms/audit/auditor-access',
  group: 'audit',
  order: 70,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'auditor', 'top'],
  perm: ['auditor_access.grant', 'ms.read'],
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (mayGrant(ctx, ctx.msObj?.id)
    ? [{ label: [TEXT.grantAction[0], TEXT.grantAction[1]], icon: 'M12 5v14M5 12h14', primary: true, run: (c) => c.go('auditor-access', { params: { grant: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
