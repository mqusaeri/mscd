// A minimal host screen (MILESTONE-2 M2-01 acceptance): copied into src/screens/zz-probe/, it is found by the screen
// registry without an edit of any shared file. It also shows the parts every screen folder has.
import { lazy } from 'react';
import type { ScreenDef } from '../types';

const screen: ScreenDef = {
  id: 'probe',
  path: '/admin/probe',
  group: 'admin',
  order: 990,
  label: ['Probe screen', 'Layar uji'],
  icon: 'M12 3v18M3 12h18',
  scope: 'org',
  roles: ['manager'],
  perm: 'ms.admin',
  Component: lazy(() => import('./Screen')),
  pageActions: () => [{ label: ['Say hello', 'Ucapkan salam'], icon: 'M5 12h14', run: (ctx) => ctx.toast(ctx.li(['Hello', 'Halo'])) }],
  tera: {
    what: ['A screen that proves the registry finds new folders.', 'Layar yang membuktikan registri menemukan folder baru.'],
    how: [['Open it from the Administration group', 'Buka dari grup Administrasi']],
  },
};

export default screen;
