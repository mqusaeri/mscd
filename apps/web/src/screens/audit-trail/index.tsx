// Audit trail (MILESTONE-2 M2-15): every change to a management system with who made it and when, in the Audit group.
// Full entries with `audit_trail.read` in the system (MS Manager, external auditor while its grant runs); the
// organisation's metadata (who and when) with `audit_trail.metadata.read` (Tenant Admin), offered inside the screen.
// The sample build shows it to the MS Manager persona only: the Internal Auditor holds neither permission (F.6), and the
// sample personas have no external auditor.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M9 4h10v16H9zM9 8H5v12h4M12 8h4M12 12h4M12 16h2';

const screen: ScreenDef = {
  id: 'audit-trail',
  path: '/ms/:ms/audit-trail',
  group: 'audit',
  order: 90,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: ['audit_trail.read', 'audit_trail.metadata.read'],
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
