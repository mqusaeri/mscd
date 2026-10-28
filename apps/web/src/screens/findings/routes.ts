// Routes of "Findings and actions" (MILESTONE-2 M2-14): `[method, path]` constants for `call()` of screens/api.ts and the
// shared route ids, which test/screens/findings.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  findingsList: ['GET', '/api/v1/ms/:ms/findings'],
  findingsCreate: ['POST', '/api/v1/ms/:ms/findings'],
  findingsUpdate: ['PATCH', '/api/v1/ms/:ms/findings/:id'],
  findingsTransition: ['POST', '/api/v1/ms/:ms/findings/:id/transitions'],
  actionsList: ['GET', '/api/v1/ms/:ms/corrective-actions'],
  actionsCreate: ['POST', '/api/v1/ms/:ms/corrective-actions'],
  actionsUpdate: ['PATCH', '/api/v1/ms/:ms/corrective-actions/:id'],
  actionsTransition: ['POST', '/api/v1/ms/:ms/corrective-actions/:id/transitions'],
  selfList: ['GET', '/api/v1/ms/:ms/self-assessments'],
  selfUpdate: ['PUT', '/api/v1/ms/:ms/self-assessments/:conditionCode'],
  selfRaise: ['POST', '/api/v1/ms/:ms/self-assessments/:id/raise-finding'],
  targets: ['GET', '/api/v1/ms/:ms/applicability/targets'],
  cycles: ['GET', '/api/v1/ms/:ms/certification-cycles'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  findingsList: 'findings.list',
  findingsCreate: 'findings.create',
  findingsUpdate: 'findings.update',
  findingsTransition: 'findings.transition',
  actionsList: 'corrective-actions.list',
  actionsCreate: 'corrective-actions.create',
  actionsUpdate: 'corrective-actions.update',
  actionsTransition: 'corrective-actions.transition',
  selfList: 'self-assessments.list',
  selfUpdate: 'self-assessments.update',
  selfRaise: 'self-assessments.raise-finding',
  targets: 'applicability.targets',
  cycles: 'ms.cycles.list',
};
