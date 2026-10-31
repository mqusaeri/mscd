// Routes of the Open work totals screen (MILESTONE-3 M3-08, D.10): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/pending-totals.test.tsx compares with the route table of
// @mscd/shared. The screen reads one existing route with `aggregate=unit` (D3-11: no server change).
import type { RouteRef } from '../api';

export const ROUTES = {
  pending: ['GET', '/api/v1/ms/:ms/audit/pending'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  pending: 'readmodel.audit.pending',
};
