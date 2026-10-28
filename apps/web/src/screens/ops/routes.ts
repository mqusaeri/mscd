// Routes of the operator console (MILESTONE-2 M2-16, M2-S12): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/ops.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  health: ['GET', '/api/v1/ops/health'],
  queues: ['GET', '/api/v1/ops/queues'],
  jobRun: ['POST', '/api/v1/ops/jobs/:name/run'],
  diagnostics: ['POST', '/api/v1/ops/diagnostics'],
  orgList: ['GET', '/api/v1/ops/organizations'],
  orgCreate: ['POST', '/api/v1/ops/organizations'],
  orgGet: ['GET', '/api/v1/ops/organizations/:org'],
  orgStatus: ['POST', '/api/v1/ops/organizations/:org/status'],
  orgEvents: ['GET', '/api/v1/ops/organizations/:org/events'],
  domainsList: ['GET', '/api/v1/ops/organizations/:org/domains'],
  domainsAdd: ['POST', '/api/v1/ops/organizations/:org/domains'],
  domainsVerify: ['POST', '/api/v1/ops/organizations/:org/domains/:domain/verify'],
  domainsRemove: ['DELETE', '/api/v1/ops/organizations/:org/domains/:domain'],
  entitlementGet: ['GET', '/api/v1/ops/organizations/:org/entitlements'],
  entitlementSet: ['PUT', '/api/v1/ops/organizations/:org/entitlements'],
  plans: ['GET', '/api/v1/ops/plans'],
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
  orgGet: 'ops.organizations.get',
  orgStatus: 'ops.organizations.status',
  orgEvents: 'ops.organizations.events',
  domainsList: 'ops.domains.list',
  domainsAdd: 'ops.domains.add',
  domainsVerify: 'ops.domains.verify',
  domainsRemove: 'ops.domains.remove',
  entitlementGet: 'ops.entitlements.get',
  entitlementSet: 'ops.entitlements.set',
  plans: 'ops.plans.list',
  resetMfa: 'ops.users.reset-mfa',
  licensePut: 'admin.license.put',
  packsList: 'admin.packs.list',
  packsImport: 'admin.packs.import',
};
