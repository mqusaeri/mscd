// Operator console (MILESTONE-2 M2-16): the platform operator's screen in the Operations group, with `ops.read` at
// platform scope. A platform operator without a membership lands here (C.3). "Create organisation" shows on a
// service with several organisations (multi tenancy), where the operator also installs licences and packs.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { multiTenancy } from './model';
import { TEXT } from './text';

const ICON = 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01M12 8h4M12 16h4';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'ops',
  path: '/ops',
  group: 'ops',
  order: 10,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'platform',
  roles: ['manager'],
  perm: 'ops.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.platformCan('ops.tenants.manage') && multiTenancy(ctx)
    ? [{ label: [TEXT.createOrg[0], TEXT.createOrg[1]], icon: PLUS, primary: true, run: (c) => c.go('ops', { params: { create: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
