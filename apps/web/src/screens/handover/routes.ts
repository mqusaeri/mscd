// Routes of the Handover screen (MILESTONE-2 M2-10): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/handover.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  holdings: ['GET', '/api/v1/ms/:ms/holdings/:handle'],
  reassign: ['POST', '/api/v1/ms/:ms/holdings/:handle/reassign'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  holdings: 'records.holdings',
  reassign: 'records.holdings.reassign',
};
