// Routes of the activity forms (MILESTONE-2 M2-11): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/phases-edit.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  transition: ['POST', '/api/v1/ms/:ms/activities/:id/transitions'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  transition: 'activity.transition',
};
