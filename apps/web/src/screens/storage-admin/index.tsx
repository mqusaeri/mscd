// Repository administration (MILESTONE-2 M2-09): the screen of the Storage repositories administration, without a
// sidebar entry (C.2). It opens with `storage.repository.manage` (Tenant Admin, Storage Admin); the claims of
// actions.ts open its wizard and settings drawers from the Storage repositories screen.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3';
const LINK = 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';

const screen: ScreenDef = {
  id: 'storage-admin',
  path: '/admin/storage/storage-admin',
  group: 'admin',
  order: 38,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'storage.repository.manage',
  nav: false,
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan('storage.repository.manage')
    ? [{ label: [TEXT.connect[0], TEXT.connect[1]], icon: LINK, primary: true, run: (c) => c.go('storage-admin', { params: { connect: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
