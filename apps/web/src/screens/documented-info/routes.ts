// Routes of Required documented information (MILESTONE-2 M2-12): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/documented-info.test.tsx compares with the route table.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/ms/:ms/documented-information'],
  link: ['PUT', '/api/v1/ms/:ms/documented-information/:code/link'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'documented-info.list',
  link: 'documented-info.link',
};
