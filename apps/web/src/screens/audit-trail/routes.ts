// Routes of the Audit trail screen (MILESTONE-2 M2-15): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/audit-trail.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/admin/audit-trail'],
  export: ['GET', '/api/v1/admin/audit-trail/export'],
  verify: ['GET', '/api/v1/admin/audit-trail/verify'],
  anchors: ['GET', '/api/v1/admin/audit-trail/anchors'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'audit-trail.list',
  export: 'audit-trail.export',
  verify: 'audit-trail.verify',
  anchors: 'audit-trail.anchors',
};
