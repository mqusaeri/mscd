// Routes of the Auditor access screen (MILESTONE-2 M2-15): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/auditor-access.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  grants: ['GET', '/api/v1/ms/:ms/auditor-access'],
  grant: ['POST', '/api/v1/ms/:ms/auditor-access'],
  revoke: ['POST', '/api/v1/ms/:ms/auditor-access/:id/revoke'],
  packs: ['GET', '/api/v1/ms/:ms/evidence-packs'],
  packDownload: ['GET', '/api/v1/ms/:ms/evidence-packs/:id/download'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  grants: 'auditor-access.list',
  grant: 'auditor-access.grant',
  revoke: 'auditor-access.revoke',
  packs: 'evidence-packs.list',
  packDownload: 'evidence-packs.download',
};
