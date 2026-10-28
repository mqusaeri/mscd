// Routes of the Registers screen (MILESTONE-2 M2-13): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/registers.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  list: ['GET', '/api/v1/ms/:ms/registers/:register'],
  create: ['POST', '/api/v1/ms/:ms/registers/:register'],
  update: ['PATCH', '/api/v1/ms/:ms/registers/:register/:id'],
  metricValue: ['POST', '/api/v1/ms/:ms/metrics/:id/values'],
  treatmentCreate: ['POST', '/api/v1/ms/:ms/risks/:id/treatments'],
  treatmentTransition: ['POST', '/api/v1/ms/:ms/treatments/:id/transitions'],
  residualAcceptance: ['POST', '/api/v1/ms/:ms/risks/:id/residual-acceptance'],
  entityLinkCreate: ['POST', '/api/v1/ms/:ms/entity-links'],
  stageRecords: ['GET', '/api/v1/ms/:ms/audit/stages/:key/records'],
  targets: ['GET', '/api/v1/ms/:ms/applicability/targets'],
  evidenceFiles: ['POST', '/api/v1/ms/:ms/evidence/:id/files'],
  objectOpen: ['GET', '/api/v1/storage/objects/:id/open'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  list: 'registers.list',
  create: 'registers.create',
  update: 'registers.update',
  metricValue: 'metrics.values.create',
  treatmentCreate: 'treatments.create',
  treatmentTransition: 'treatments.transition',
  residualAcceptance: 'risks.residual-acceptance',
  entityLinkCreate: 'entity-links.create',
  stageRecords: 'readmodel.audit.stage-records',
  targets: 'applicability.targets',
  evidenceFiles: 'evidence.files',
  objectOpen: 'storage.objects.open',
};
