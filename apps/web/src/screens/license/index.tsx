// Licence (MILESTONE-2 M2-01): the reference screen of the screen host, in the Administration group. Visible with
// `license.read` (Tenant Admin, Top Management); "Install licence" with `license.manage` (C.2, D.1).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4M4 7v14h11';

const screen: ScreenDef = {
  id: 'license',
  path: '/admin/license',
  group: 'admin',
  order: 30,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager', 'top'],
  perm: 'license.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan('license.manage')
    ? [{ label: [TEXT.install[0], TEXT.install[1]], icon: 'M12 3v12M7 8l5-5 5 5M4 19h16', primary: true, run: (c) => c.go('license', { params: { install: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
