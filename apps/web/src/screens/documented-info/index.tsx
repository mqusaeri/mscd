// Required documented information (MILESTONE-2 M2-12): the documents to maintain and records to retain of the system's
// edition, per clause, with the document or evidence that covers each (`documented-info.list`, D.1), "Register from
// template", "Link existing document" (`documented-info.link`, BR-40) and the scope panel of H.9. In the Implementation
// group after Document register, for everyone who reads the system (`ms.read`); the badge counts the missing items.
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { badgeCount } from './badge';
import { TEXT } from './text';

const ICON = 'M9 3h6l4 4v14H5V3h4M14 3v5h5M8 13l2 2 4-4M8 18h8';

const screen: ScreenDef = {
  id: 'documented-info',
  path: '/ms/:ms/documented-info',
  group: 'impl',
  order: 45,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'ms',
  roles: ['manager', 'owner', 'auditor', 'top'],
  perm: 'ms.read',
  Component: lazy(() => import('./Screen')),
  count: (ctx) => badgeCount(ctx),
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
