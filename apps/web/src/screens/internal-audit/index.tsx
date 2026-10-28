// Internal audit (MILESTONE-2 M2-14, `/ms/:ms/internal-audit`): the internal audit programme of the certification
// cycle and its internal audits, in the Audit group. Visible with `ms.read`; "Plan internal audit" for MS Managers and
// Internal Auditors (`internal_audit.manage`, D.2).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 13l2 2 4-4';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'internal-audit',
  path: '/ms/:ms/internal-audit',
  group: 'audit',
  order: 40,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'auditor', 'top'],
  perm: 'ms.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.msObj && ctx.can(ctx.msObj.id, ['internal_audit.manage', 'audit_event.manage'])
    ? [{ label: [TEXT.plan[0], TEXT.plan[1]], icon: PLUS, primary: true, run: (c) => c.go('internal-audit', { params: { plan: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
