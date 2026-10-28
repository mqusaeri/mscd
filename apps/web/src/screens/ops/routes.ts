// Routes of the operator console (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/ops.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  health: ['GET', '/api/v1/ops/health'],
  queues: ['GET', '/api/v1/ops/queues'],
  jobRun: ['POST', '/api/v1/ops/jobs/:name/run'],
  diagnostics: ['POST', '/api/v1/ops/diagnostics'],
  orgList: ['GET', '/api/v1/ops/organizations'],
  orgCreate: ['POST', '/api/v1/ops/organizations'],
  resetMfa: ['POST', '/api/v1/ops/users/reset-mfa'],
  licensePut: ['PUT', '/api/v1/admin/license'],
  packsList: ['GET', '/api/v1/admin/packs'],
  packsImport: ['POST', '/api/v1/admin/packs/import'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  health: 'ops.health',
  queues: 'ops.queues',
  jobRun: 'ops.jobs.run',
  diagnostics: 'ops.diagnostics',
  orgList: 'ops.organizations.list',
  orgCreate: 'ops.organizations.create',
  resetMfa: 'ops.users.reset-mfa',
  licensePut: 'admin.license.put',
  packsList: 'admin.packs.list',
  packsImport: 'admin.packs.import',
};
