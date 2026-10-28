// Routes of the notification bell and panel (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/notifications.test.tsx compares with the route table.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/notifications'],
  read: ['POST', '/api/v1/notifications/:id/read'],
  readAll: ['POST', '/api/v1/notifications/read-all'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'notifications.list',
  read: 'notifications.read',
  readAll: 'notifications.read-all',
};
