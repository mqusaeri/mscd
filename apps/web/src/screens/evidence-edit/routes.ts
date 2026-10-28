// Routes of the evidence forms (MILESTONE-2 M2-11): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/evidence-edit.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  create: ['POST', '/api/v1/ms/:ms/evidence'],
  update: ['PATCH', '/api/v1/ms/:ms/evidence/:id'],
  targetAdd: ['POST', '/api/v1/ms/:ms/evidence/:id/targets'],
  targetRemove: ['POST', '/api/v1/ms/:ms/evidence/:id/targets/:targetId/remove'],
  list: ['GET', '/api/v1/ms/:ms/evidence'],
  files: ['POST', '/api/v1/ms/:ms/evidence/:id/files'],
  thresholds: ['GET', '/api/v1/ms/:ms/freshness-thresholds'],
  thresholdSet: ['PUT', '/api/v1/ms/:ms/freshness-thresholds/:frequencyCode'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  create: 'evidence.create',
  update: 'evidence.update',
  targetAdd: 'evidence.targets.create',
  targetRemove: 'evidence.targets.remove',
  list: 'readmodel.evidence.list',
  files: 'evidence.files',
  thresholds: 'freshness.thresholds.get',
  thresholdSet: 'freshness.thresholds.put',
};
