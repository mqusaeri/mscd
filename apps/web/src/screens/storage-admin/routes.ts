// Routes of the repository administration (MILESTONE-2 M2-09): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/storage-admin.test.tsx compares with the route table of
// @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  reposList: ['GET', '/api/v1/admin/storage/repositories'],
  reposCreate: ['POST', '/api/v1/admin/storage/repositories'],
  reposUpdate: ['PATCH', '/api/v1/admin/storage/repositories/:id'],
  reposCredentials: ['PUT', '/api/v1/admin/storage/repositories/:id/credentials'],
  reposTest: ['POST', '/api/v1/admin/storage/repositories/:id/test'],
  reposReauthorize: ['POST', '/api/v1/admin/storage/repositories/:id/reauthorize'],
  licenseGet: ['GET', '/api/v1/license'],
  msList: ['GET', '/api/v1/admin/management-systems'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  reposList: 'admin.storage.repositories.list',
  reposCreate: 'admin.storage.repositories.create',
  reposUpdate: 'admin.storage.repositories.update',
  reposCredentials: 'admin.storage.repositories.credentials',
  reposTest: 'admin.storage.repositories.test',
  reposReauthorize: 'admin.storage.repositories.reauthorize',
  licenseGet: 'license.get',
  msList: 'admin.ms.list',
};
