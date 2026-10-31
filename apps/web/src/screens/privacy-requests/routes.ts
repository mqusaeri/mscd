// Routes of Personal data requests (MILESTONE-3 M3-04, D.1): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/privacy-requests.test.tsx compares with the route table of
// @mscd/shared. The member list of the subject picker and the export state come from existing routes.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/admin/privacy-requests'],
  create: ['POST', '/api/v1/admin/privacy-requests'],
  get: ['GET', '/api/v1/admin/privacy-requests/:id'],
  update: ['PATCH', '/api/v1/admin/privacy-requests/:id'],
  rectify: ['POST', '/api/v1/admin/privacy-requests/:id/rectify'],
  restrict: ['POST', '/api/v1/admin/privacy-requests/:id/restrict'],
  erase: ['POST', '/api/v1/admin/privacy-requests/:id/erase'],
  close: ['POST', '/api/v1/admin/privacy-requests/:id/close'],
  exportPerson: ['POST', '/api/v1/admin/privacy-requests/:id/export'],
  exportState: ['GET', '/api/v1/exports/:taskId'],
  members: ['GET', '/api/v1/admin/users'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'privacy-requests.list',
  create: 'privacy-requests.create',
  get: 'privacy-requests.get',
  update: 'privacy-requests.update',
  rectify: 'privacy-requests.rectify',
  restrict: 'privacy-requests.restrict',
  erase: 'privacy-requests.erase',
  close: 'privacy-requests.close',
  exportPerson: 'exports.person.create',
  exportState: 'exports.get',
  members: 'admin.users.list',
};
