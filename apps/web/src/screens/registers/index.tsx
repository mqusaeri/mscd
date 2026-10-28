// Registers (MILESTONE-2 M2-13, `/ms/:ms/registers`): context issues, interested parties, assets, risks with their
// treatments and residual acceptance, metrics with their values, objectives and competence records of the selected
// management system, in the Implementation group. Visible with `ms.read`; "Add record" for whoever may add to one of
// the registers (`register.manage`, own rows included, or `risk.manage`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { screenModule } from './load';
import { TEXT } from './text';

const ICON = 'M4 4h16v16H4zM4 9h16M4 14h16M9 9v11';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'registers',
  path: '/ms/:ms/registers',
  group: 'impl',
  order: 50,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'owner', 'auditor', 'top'],
  perm: 'ms.read',
  Component: lazy(screenModule),
  pageActions: (ctx) => (ctx.msObj && ctx.can(ctx.msObj.id, ['register.manage', 'risk.manage'])
    ? [{ label: [TEXT.addRecord[0], TEXT.addRecord[1]], icon: PLUS, primary: true, run: (c) => c.go('registers', { params: { add: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
