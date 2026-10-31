// Routes of Organisation export (MILESTONE-3 M3-09, D.1, D.2): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/org-export.test.tsx compares with the route table of
// @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  organization: ['GET', '/api/v1/admin/organization'],
  list: ['GET', '/api/v1/admin/organization/exports'],
  create: ['POST', '/api/v1/admin/organization/exports'],
  get: ['GET', '/api/v1/admin/organization/exports/:id'],
  decide: ['POST', '/api/v1/admin/organization/exports/:id/decision'],
  manifest: ['GET', '/api/v1/admin/organization/exports/:id/manifest'],
  download: ['GET', '/api/v1/admin/organization/exports/:id/parts/:part'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  organization: 'admin.organization.get',
  list: 'exports.organization.list',
  create: 'exports.organization.create',
  get: 'exports.organization.get',
  decide: 'exports.organization.decide',
  manifest: 'exports.organization.manifest',
  download: 'exports.organization.download',
};

/** A path of a route with its `:name` segments filled in. */
export function pathOf(route: RouteRef, params: Record<string, string>): string {
  return route[1].replace(/:([a-zA-Z]+)/g, (_m, name: string) => encodeURIComponent(params[name] ?? ''));
}
