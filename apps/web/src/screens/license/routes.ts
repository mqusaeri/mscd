// Routes of the Licence screen (MILESTONE-2 M2-01; the installation id of M2-16): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/license.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  licenseGet: ['GET', '/api/v1/license'],
  licensePut: ['PUT', '/api/v1/admin/license'],
  organizationGet: ['GET', '/api/v1/admin/organization'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  licenseGet: 'license.get',
  licensePut: 'admin.license.put',
  organizationGet: 'admin.organization.get',
};
