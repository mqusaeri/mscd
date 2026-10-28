// Routes of the Import screen (MILESTONE-2 M2-08): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/import.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  template: ['GET', '/api/v1/ms/:ms/imports/templates/:kind'],
  create: ['POST', '/api/v1/ms/:ms/imports/:kind'],
  get: ['GET', '/api/v1/ms/:ms/imports/:id'],
  commit: ['POST', '/api/v1/ms/:ms/imports/:id/commit'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  template: 'imports.templates',
  create: 'imports.create',
  get: 'imports.get',
  commit: 'imports.commit',
};

/** A path of `ROUTES` with its `:name` segments filled (each value URL-encoded). */
export function pathOf(route: readonly [string, string], params: Record<string, string>): string {
  return route[1].replace(/:([A-Za-z]+)/g, (_m, name: string) => encodeURIComponent(params[name] ?? ''));
}
