// Routes of "Policy read confirmations" (MILESTONE-3 M3-05, D.1): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/acknowledgements.test.tsx compares with the route table of
// @mscd/shared. `documentUpdate` saves the read confirmation settings of a document (D.2).
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/ms/:ms/acknowledgement-requests'],
  create: ['POST', '/api/v1/ms/:ms/acknowledgement-requests'],
  get: ['GET', '/api/v1/ms/:ms/acknowledgement-requests/:id'],
  remind: ['POST', '/api/v1/ms/:ms/acknowledgement-requests/:id/remind'],
  close: ['POST', '/api/v1/ms/:ms/acknowledgement-requests/:id/close'],
  export: ['GET', '/api/v1/ms/:ms/acknowledgement-requests/:id/export'],
  documentUpdate: ['PATCH', '/api/v1/ms/:ms/documents/:id'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'acknowledgement-requests.list',
  create: 'acknowledgement-requests.create',
  get: 'acknowledgement-requests.get',
  remind: 'acknowledgement-requests.remind',
  close: 'acknowledgement-requests.close',
  export: 'acknowledgement-requests.export',
  documentUpdate: 'documents.update',
};

/** A route's path with its `:name` segments filled (links the browser follows, such as the CSV). */
export function pathOf(route: RouteRef, params: Record<string, string>): string {
  return route[1].replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(params[name] ?? ''));
}
