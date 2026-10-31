// Routes of "Policies to confirm" (MILESTONE-3 M3-05, D.1): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/my-confirmations.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  mine: ['GET', '/api/v1/me/acknowledgements'],
  open: ['POST', '/api/v1/me/acknowledgements/:id/open'],
  confirm: ['POST', '/api/v1/me/acknowledgements/:id/confirm'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  mine: 'me.acknowledgements',
  open: 'me.acknowledgements.open',
  confirm: 'me.acknowledgements.confirm',
};
