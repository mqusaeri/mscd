// Findings and actions (MILESTONE-2 M2-14, `/ms/:ms/findings`): the finding register, corrective actions and the
// self-assessment of the selected management system, in the Audit group. Visible with `ms.read`; "Raise finding" for
// MS Managers and Internal Auditors (`finding.raise`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M5 21V4M5 4h11l-2 4 2 4H5';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'findings',
  path: '/ms/:ms/findings',
  group: 'audit',
  order: 50,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'auditor', 'top', 'owner'],
  perm: 'ms.read',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.msObj && ctx.can(ctx.msObj.id, 'finding.raise')
    ? [{ label: [TEXT.raise[0], TEXT.raise[1]], icon: PLUS, primary: true, run: (c) => c.go('findings', { params: { raise: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
