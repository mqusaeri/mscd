// Import (MILESTONE-2 M2-08, D2-13): bulk import of the Statement of Applicability, documents, risks and evidence from
// one XLSX or CSV file, checked first and imported as a whole. In the Implementation group of the selected system,
// for whoever may manage one of the four kinds there (D.1 `imports.create`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { KIND_PERMS } from './model';
import { TEXT } from './text';

const ICON = 'M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4';

const screen: ScreenDef = {
  id: 'import',
  path: '/ms/:ms/import',
  group: 'impl',
  order: 60,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: Object.values(KIND_PERMS),
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
