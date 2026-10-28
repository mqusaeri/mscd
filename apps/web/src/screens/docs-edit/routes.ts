// Routes of the document control forms (MILESTONE-2 M2-12): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/docs-edit.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  create: ['POST', '/api/v1/ms/:ms/documents'],
  update: ['PATCH', '/api/v1/ms/:ms/documents/:id'],
  transition: ['POST', '/api/v1/ms/:ms/documents/:id/transitions'],
  addVersion: ['POST', '/api/v1/ms/:ms/documents/:id/versions'],
  versions: ['GET', '/api/v1/ms/:ms/documents/:id/versions'],
  assign: ['POST', '/api/v1/ms/:ms/records/:entityType/:id/assignment'],
  openFile: ['GET', '/api/v1/storage/objects/:id/open'],
  documentedInfo: ['GET', '/api/v1/ms/:ms/documented-information'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  create: 'documents.create',
  update: 'documents.update',
  transition: 'documents.transition',
  addVersion: 'documents.versions',
  versions: 'documents.versions.list',
  assign: 'records.assign',
  openFile: 'storage.objects.open',
  documentedInfo: 'documented-info.list',
};
