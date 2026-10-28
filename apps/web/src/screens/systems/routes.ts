// Routes of the Management systems screen and the edition transition drawer (MILESTONE-2 M2-09): `[method, path]`
// constants for `call()` of screens/api.ts and the shared route ids, which test/screens/systems.test.tsx compares
// with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  msList: ['GET', '/api/v1/admin/management-systems'],
  msCreate: ['POST', '/api/v1/admin/management-systems'],
  msUpdate: ['PATCH', '/api/v1/admin/management-systems/:id'],
  msTransition: ['POST', '/api/v1/ms/:ms/transitions'],
  packsList: ['GET', '/api/v1/admin/packs'],
  reposList: ['GET', '/api/v1/admin/storage/repositories'],
  usersList: ['GET', '/api/v1/admin/users'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  msList: 'admin.ms.list',
  msCreate: 'admin.ms.create',
  msUpdate: 'admin.ms.update',
  msTransition: 'ms.transition',
  packsList: 'admin.packs.list',
  reposList: 'admin.storage.repositories.list',
  usersList: 'admin.users.list',
};
