// Personal data checks (MILESTONE-3 M3-04, C.2, D.6.4): the checks a request from one person asks of this system, in
// My Tasks, for the Management System Managers (`privacy_request.assist`).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

/** A magnifier over a person: looking for one person in the records. */
const ICON = 'M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 18a5.5 5.5 0 0 1 8.7-4.5M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 22l-1.9-1.9';

const screen: ScreenDef = {
  id: 'privacy-checks',
  path: '/ms/:ms/privacy-checks',
  group: 'tasks',
  order: 30,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager'],
  perm: 'privacy_request.assist',
  Component: lazy(() => import('./Screen')),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
