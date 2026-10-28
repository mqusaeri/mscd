// Routes of the Company sign-in screen (MILESTONE-2 M2-10): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/identity-providers.test.tsx compares with the route table of
// @mscd/shared. The SP metadata and the OIDC callback are addresses shown on screen, never called by it.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/admin/identity-providers'],
  create: ['POST', '/api/v1/admin/identity-providers'],
  update: ['PATCH', '/api/v1/admin/identity-providers/:id'],
  test: ['POST', '/api/v1/admin/identity-providers/:id/test'],
  orgGet: ['GET', '/api/v1/admin/organization'],
  orgUpdate: ['PATCH', '/api/v1/admin/organization'],
  samlMetadata: ['GET', '/api/v1/auth/saml/:slug/metadata'],
  oidcCallback: ['GET', '/api/v1/auth/oidc/:slug/callback'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'admin.idp.list',
  create: 'admin.idp.create',
  update: 'admin.idp.update',
  test: 'admin.idp.test',
  orgGet: 'admin.organization.get',
  orgUpdate: 'admin.organization.update',
  samlMetadata: 'auth.saml.metadata',
  oidcCallback: 'auth.oidc.callback',
};

/** An address of a route with its `:slug` filled, for links and the redirect address shown in the OIDC form. */
export function pathOf(route: readonly [string, string], slug: string): string {
  return route[1].replace(':slug', slug ? encodeURIComponent(slug) : '<id>');
}
