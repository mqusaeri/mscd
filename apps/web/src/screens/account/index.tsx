// My account (MILESTONE-2 M2-16): the session user's own account, opened from the "My account" entry of the top bar
// (no sidebar entry). Every business role reads its system (`ms.read`), so the screen opens for every person with a
// role; a session without a system (an administrator without a business role, a platform operator) gets the same page
// in a drawer from the top bar entry (actions.ts).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** The person icon of the screen and of the top bar entry. */
export const ACCOUNT_ICON = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0';

const screen: ScreenDef = {
  id: 'account',
  path: '/account',
  group: 'top',
  order: 900,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ACCOUNT_ICON,
  scope: 'ms',
  roles: ['manager', 'owner', 'auditor', 'top'],
  perm: 'ms.read',
  nav: false,
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
