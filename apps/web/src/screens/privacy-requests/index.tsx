// Personal data requests (MILESTONE-3 M3-04, C.2, D.6): requests from one person about their own personal data, in the
// Administration group, for the Tenant Admins (`privacy_request.manage`). The page action "Record request" opens the
// form of a new request.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** A person with a shield: a person's own data, protected. */
export const ICON = 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6 6 0 0 1 9.5-4.9M17 12l4 1.5V17c0 2-1.7 3.4-4 4-2.3-.6-4-2-4-4v-3.5L17 12z';
const PLUS = 'M12 5v14M5 12h14';

const screen: ScreenDef = {
  id: 'privacy-requests',
  path: '/admin/privacy-requests',
  group: 'admin',
  order: 44,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'privacy_request.manage',
  Component: lazy(() => import('./Screen')),
  pageActions: (ctx) => (ctx.orgCan('privacy_request.manage')
    ? [{ label: [TEXT.record[0], TEXT.record[1]], icon: PLUS, primary: true, run: (c) => c.go('privacy-requests', { params: { record: Date.now() } }) }]
    : []),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
