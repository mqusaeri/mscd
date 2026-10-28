// Routes of the Getting started screen (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/getting-started.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  onboarding: ['GET', '/api/v1/admin/onboarding'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  onboarding: 'admin.onboarding',
};
