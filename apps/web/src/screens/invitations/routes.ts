// Routes of the invitation banner (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/invitations.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  accept: ['POST', '/api/v1/me/memberships/:org/accept'],
  decline: ['POST', '/api/v1/me/memberships/:org/decline'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  accept: 'me.membership.accept',
  decline: 'me.membership.decline',
};
