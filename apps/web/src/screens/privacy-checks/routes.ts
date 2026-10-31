// Routes of Personal data checks (MILESTONE-3 M3-04, D.1): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/privacy-checks.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/ms/:ms/privacy-checks'],
  mentions: ['GET', '/api/v1/ms/:ms/privacy-checks/:id/mentions'],
  done: ['POST', '/api/v1/ms/:ms/privacy-checks/:id/done'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'privacy-checks.list',
  mentions: 'privacy-checks.mentions',
  done: 'privacy-checks.done',
};
