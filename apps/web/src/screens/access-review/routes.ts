// Routes of Access review of this system (MILESTONE-3 M3-07, D.1): the system routes of the shared route table of
// ../access-reviews/routes.ts, which test/screens/access-review.test.tsx compares with @mscd/shared.
import { ROUTES as ALL, ROUTE_IDS as ALL_IDS } from '../access-reviews/routes';

export const ROUTES = { msList: ALL.msList, msGet: ALL.msGet, msDecide: ALL.msDecide, msApply: ALL.msApply, signOff: ALL.signOff } as const;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  msList: ALL_IDS.msList, msGet: ALL_IDS.msGet, msDecide: ALL_IDS.msDecide, msApply: ALL_IDS.msApply, signOff: ALL_IDS.signOff,
};
