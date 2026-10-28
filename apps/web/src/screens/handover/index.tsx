// Handover (MILESTONE-2 M2-10): the open items one person holds in the selected management system and their move to a
// successor, in the Audit group. Visible with `record.assign` in the system (MS Manager, Programme Owner; H.13).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7';

const screen: ScreenDef = {
  id: 'handover',
  path: '/ms/:ms/handover',
  group: 'audit',
  order: 80,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: 'record.assign',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
