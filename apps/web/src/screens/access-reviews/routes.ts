// Routes of Access reviews and Access review of this system (MILESTONE-3 M3-07, D.1): `[method, path]` constants for
// `call()` of screens/api.ts and the shared route ids, which test/screens/access-reviews.test.tsx compares with the
// route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  settings: ['GET', '/api/v1/admin/access-reviews/settings'],
  putSettings: ['PUT', '/api/v1/admin/access-reviews/settings'],
  list: ['GET', '/api/v1/admin/access-reviews'],
  create: ['POST', '/api/v1/admin/access-reviews'],
  get: ['GET', '/api/v1/admin/access-reviews/:id'],
  decide: ['POST', '/api/v1/admin/access-reviews/:id/items/:itemId/decision'],
  apply: ['POST', '/api/v1/admin/access-reviews/:id/items/:itemId/apply'],
  complete: ['POST', '/api/v1/admin/access-reviews/:id/complete'],
  cancel: ['POST', '/api/v1/admin/access-reviews/:id/cancel'],
  report: ['GET', '/api/v1/admin/access-reviews/:id/report'],
  msList: ['GET', '/api/v1/ms/:ms/access-reviews'],
  msGet: ['GET', '/api/v1/ms/:ms/access-reviews/:id'],
  msDecide: ['POST', '/api/v1/ms/:ms/access-reviews/:id/items/:itemId/decision'],
  msApply: ['POST', '/api/v1/ms/:ms/access-reviews/:id/items/:itemId/apply'],
  signOff: ['POST', '/api/v1/ms/:ms/access-reviews/:id/sign-off'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  settings: 'access-reviews.settings.get',
  putSettings: 'access-reviews.settings.put',
  list: 'access-reviews.list',
  create: 'access-reviews.create',
  get: 'access-reviews.get',
  decide: 'access-reviews.decide',
  apply: 'access-reviews.apply',
  complete: 'access-reviews.complete',
  cancel: 'access-reviews.cancel',
  report: 'access-reviews.report',
  msList: 'access-reviews.ms.list',
  msGet: 'access-reviews.ms.get',
  msDecide: 'access-reviews.ms.decide',
  msApply: 'access-reviews.ms.apply',
  signOff: 'access-reviews.ms.sign-off',
};

/** A path of a route with its `:name` segments filled in. */
export function pathOf(route: RouteRef, params: Record<string, string>): string {
  return route[1].replace(/:([a-zA-Z]+)/g, (_m, name: string) => encodeURIComponent(params[name] ?? ''));
}
