// Company sign-in (MILESTONE-2 M2-10): the OIDC and SAML identity providers of the organisation and the local sign-in
// policy, in the Administration group. Visible with `idp.manage` (Tenant Admin). The id keeps clear of the sign-in
// pages of src/auth; the path keeps the intended `/admin/sign-in` prefix and ends with the id (D2-14).
import { lazy } from 'react';
import type { ScreenDef } from '../types';
import { TEXT } from './text';

const ICON = 'M15 7a3 3 0 1 1-3 3M12 10l-8 8v3h3l1-1v-2h2v-2h2l1.5-1.5M15 7a3 3 0 0 1 3 3';

const screen: ScreenDef = {
  id: 'identity-providers',
  path: '/admin/sign-in/identity-providers',
  group: 'admin',
  order: 46,
  label: [TEXT.title[0], TEXT.title[1]],
  icon: ICON,
  scope: 'org',
  roles: ['manager'],
  perm: 'idp.manage',
  Component: lazy(() => import('./Screen')),
  pageActions: () => [
    { label: [TEXT.addOidc[0], TEXT.addOidc[1]], icon: 'M12 5v14M5 12h14', primary: true, run: (c) => c.go('identity-providers', { params: { add: 'oidc', at: Date.now() } }) },
    { label: [TEXT.addSaml[0], TEXT.addSaml[1]], icon: 'M12 5v14M5 12h14', run: (c) => c.go('identity-providers', { params: { add: 'saml', at: Date.now() } }) },
  ],
  tera: {
    what: [TEXT.teraWhat[0], TEXT.teraWhat[1]],
    how: [TEXT.teraHow1, TEXT.teraHow2, TEXT.teraHow3].map((h) => [h[0], h[1]]),
  },
};

export default screen;
