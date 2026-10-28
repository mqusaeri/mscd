// Routes of the Management review screen (MILESTONE-2 M2-14): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/management-review.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/ms/:ms/management-reviews'],
  create: ['POST', '/api/v1/ms/:ms/management-reviews'],
  update: ['PATCH', '/api/v1/ms/:ms/management-reviews/:id'],
  input: ['PUT', '/api/v1/ms/:ms/management-reviews/:id/inputs/:defCode'],
  transition: ['POST', '/api/v1/ms/:ms/management-reviews/:id/transitions'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'management-reviews.list',
  create: 'management-reviews.create',
  update: 'management-reviews.update',
  input: 'management-reviews.input',
  transition: 'management-reviews.transition',
};
