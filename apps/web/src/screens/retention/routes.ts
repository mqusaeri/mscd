// Routes of the Retention and disposal screen (MILESTONE-3 M3-06, D.1): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/retention.test.tsx compares with the route table of
// @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  rules: ['GET', '/api/v1/ms/:ms/retention/rules'],
  putRule: ['PUT', '/api/v1/ms/:ms/retention/rules/:recordClass'],
  reviews: ['GET', '/api/v1/ms/:ms/retention/reviews'],
  decide: ['POST', '/api/v1/ms/:ms/retention/reviews/decide'],
  approve: ['POST', '/api/v1/ms/:ms/retention/reviews/:id/approve'],
  reject: ['POST', '/api/v1/ms/:ms/retention/reviews/:id/reject'],
  fileRemoved: ['POST', '/api/v1/ms/:ms/retention/reviews/:id/file-removed'],
  register: ['GET', '/api/v1/ms/:ms/retention/register'],
  holds: ['GET', '/api/v1/ms/:ms/retention/holds'],
  createHold: ['POST', '/api/v1/ms/:ms/retention/holds'],
  releaseHold: ['POST', '/api/v1/ms/:ms/retention/holds/:id/release'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  rules: 'retention.rules.list',
  putRule: 'retention.rules.put',
  reviews: 'retention.reviews.list',
  decide: 'retention.reviews.decide',
  approve: 'retention.reviews.approve',
  reject: 'retention.reviews.reject',
  fileRemoved: 'retention.reviews.file-removed',
  register: 'retention.register',
  holds: 'retention.holds.list',
  createHold: 'retention.holds.create',
  releaseHold: 'retention.holds.release',
};
