// Routes of the certification timeline forms (MILESTONE-2 M2-15): `[method, path]` constants for `call()` of
// screens/api.ts and the shared route ids, which test/screens/timeline-edit.test.tsx compares with the route table of
// @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  cycles: ['GET', '/api/v1/ms/:ms/certification-cycles'],
  cycleCreate: ['POST', '/api/v1/ms/:ms/certification-cycles'],
  certification: ['POST', '/api/v1/ms/:ms/certification'],
  cycleTransition: ['POST', '/api/v1/ms/:ms/certification-cycles/:id/transitions'],
  eventCreate: ['POST', '/api/v1/ms/:ms/audit-events'],
  eventUpdate: ['PATCH', '/api/v1/ms/:ms/audit-events/:id'],
  eventDetail: ['GET', '/api/v1/ms/:ms/surveillance/events/:id'],
  activities: ['GET', '/api/v1/ms/:ms/audit-events/:id/activities'],
  activitiesGenerate: ['POST', '/api/v1/ms/:ms/audit-events/:id/activities/generate'],
  activityUpdate: ['PATCH', '/api/v1/ms/:ms/audit-activities/:id'],
  prepUpdate: ['PATCH', '/api/v1/ms/:ms/prep-tasks/:id'],
  cycleItemUpdate: ['PATCH', '/api/v1/ms/:ms/cycle-items/:id'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  cycles: 'ms.cycles.list',
  cycleCreate: 'ms.cycles.create',
  certification: 'ms.certification',
  cycleTransition: 'ms.cycles.transition',
  eventCreate: 'audit-events.create',
  eventUpdate: 'audit-events.update',
  eventDetail: 'readmodel.surveillance.event',
  activities: 'audit-activities.list',
  activitiesGenerate: 'audit-activities.generate',
  activityUpdate: 'audit-activities.update',
  prepUpdate: 'prep-tasks.update',
  cycleItemUpdate: 'cycle-items.update',
};
