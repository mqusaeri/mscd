// Extension point of Organisation export (MILESTONE-3 M3-09, C.1, D.2): the banner of the host layer that tells the
// Tenant Admins (`org.export.manage`) of the read-only period after a contract ends and the planned deletion date, in
// both builds (the sample organisation is active until the sample operator moves it to offboarding).
import type { ScreenActions } from '../types';
import { ReadOnlyBanner } from './Banner';

export const layerItems: ScreenActions['layerItems'] = [
  { id: 'org-export.read-only', order: 14, Component: ReadOnlyBanner, visible: (ctx) => Boolean(ctx.org) && ctx.orgCan('org.export.manage') },
];
