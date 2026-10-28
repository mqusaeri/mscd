// Routes of the Internal audit screen (MILESTONE-2 M2-14): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/internal-audit.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  cycles: ['GET', '/api/v1/ms/:ms/certification-cycles'],
  programme: ['GET', '/api/v1/ms/:ms/internal-audit/programme'],
  eventCreate: ['POST', '/api/v1/ms/:ms/audit-events'],
  eventUpdate: ['PATCH', '/api/v1/ms/:ms/audit-events/:id'],
  eventDetail: ['GET', '/api/v1/ms/:ms/surveillance/events/:id'],
  activities: ['GET', '/api/v1/ms/:ms/audit-events/:id/activities'],
  activitiesGenerate: ['POST', '/api/v1/ms/:ms/audit-events/:id/activities/generate'],
  activityUpdate: ['PATCH', '/api/v1/ms/:ms/audit-activities/:id'],
  targets: ['GET', '/api/v1/ms/:ms/applicability/targets'],
  documentCreate: ['POST', '/api/v1/ms/:ms/documents'],
  documentVersion: ['POST', '/api/v1/ms/:ms/documents/:id/versions'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  cycles: 'ms.cycles.list',
  programme: 'internal-audit.programme',
  eventCreate: 'audit-events.create',
  eventUpdate: 'audit-events.update',
  eventDetail: 'readmodel.surveillance.event',
  activities: 'audit-activities.list',
  activitiesGenerate: 'audit-activities.generate',
  activityUpdate: 'audit-activities.update',
  targets: 'applicability.targets',
  documentCreate: 'documents.create',
  documentVersion: 'documents.versions',
};
