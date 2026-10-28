// Routes of the Routing rules screen (MILESTONE-2 M2-09): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/routing.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  rulesList: ['GET', '/api/v1/admin/storage/routing-rules'],
  rulesCreate: ['POST', '/api/v1/admin/storage/routing-rules'],
  rulesUpdate: ['PATCH', '/api/v1/admin/storage/routing-rules/:id'],
  rulesApprove: ['POST', '/api/v1/admin/storage/routing-rules/:id/approve'],
  rulesReject: ['POST', '/api/v1/admin/storage/routing-rules/:id/reject'],
  objectsList: ['GET', '/api/v1/admin/storage/objects'],
  reposList: ['GET', '/api/v1/admin/storage/repositories'],
  msList: ['GET', '/api/v1/admin/management-systems'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  rulesList: 'admin.storage.routing-rules.list',
  rulesCreate: 'admin.storage.routing-rules.create',
  rulesUpdate: 'admin.storage.routing-rules.update',
  rulesApprove: 'admin.storage.routing-rules.approve',
  rulesReject: 'admin.storage.routing-rules.reject',
  objectsList: 'admin.storage.objects.list',
  reposList: 'admin.storage.repositories.list',
  msList: 'admin.ms.list',
};
