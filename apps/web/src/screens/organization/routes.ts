// Routes of the Organisation screen (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/organization.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  get: ['GET', '/api/v1/admin/organization'],
  update: ['PATCH', '/api/v1/admin/organization'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  get: 'admin.organization.get',
  update: 'admin.organization.update',
};
