// Management review (MILESTONE-2 M2-14, `/ms/:ms/management-review`): the management reviews of the selected system,
// in the Audit group. Visible with `ms.read`; "Plan review" for MS Managers and Programme Owners
// (`management_review.manage`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M4 5h16v11H4zM8 20h8M12 16v4M8 9h8M8 12h5';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'management-review',
  path: '/ms/:ms/management-review',
  group: 'audit',
  order: 60,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'top', 'auditor'],
  perm: 'ms.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.msObj && ctx.can(ctx.msObj.id, 'management_review.manage')
    ? [{ label: [TEXT.plan[0], TEXT.plan[1]], icon: PLUS, primary: true, run: (c) => c.go('management-review', { params: { plan: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
