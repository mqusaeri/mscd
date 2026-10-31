// Organisation export (MILESTONE-3 M3-09, C.2, D.4): the full export of the organisation, in the Administration group,
// for the Tenant Admins (`org.export.manage`). The page action "Export all data" opens the request with what the archive
// holds and who is told.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { ICON, SCREEN_ID } from './model';
import { TEXT } from './text';

const DOWNLOAD = 'M12 4v11M7 10l5 5 5-5M5 20h14';

const screen: ScreenDef = {
  id: SCREEN_ID,
  path: '/admin/org-export',
  group: 'admin',
  order: 48,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'org.export.manage',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan('org.export.manage')
    ? [{ label: [TEXT.exportAll[0], TEXT.exportAll[1]], icon: DOWNLOAD, primary: true, run: (c) => c.go(SCREEN_ID, { params: { request: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
