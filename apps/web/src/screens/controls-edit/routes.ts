// Routes of the controls and requirements forms (MILESTONE-2 M2-11): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/controls-edit.test.tsx compares with the route table of
// @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  targets: ['GET', '/api/v1/ms/:ms/applicability/targets'],
  create: ['POST', '/api/v1/ms/:ms/applicability'],
  update: ['PATCH', '/api/v1/ms/:ms/applicability/:id'],
  transition: ['POST', '/api/v1/ms/:ms/applicability/:id/transitions'],
  criteria: ['PUT', '/api/v1/ms/:ms/applicability/:id/operating-criteria'],
  remove: ['POST', '/api/v1/ms/:ms/records/:entityType/:id/delete'],
  registers: ['GET', '/api/v1/ms/:ms/registers/:register'],
  documents: ['GET', '/api/v1/ms/:ms/documents'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  targets: 'applicability.targets',
  create: 'applicability.create',
  update: 'applicability.update',
  transition: 'applicability.transition',
  criteria: 'applicability.operating-criteria',
  remove: 'records.delete',
  registers: 'registers.list',
  documents: 'readmodel.documents.list',
};
