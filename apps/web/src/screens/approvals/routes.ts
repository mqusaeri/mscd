// Routes of the Pending approvals screen (MILESTONE-2 M2-10): the role grant decisions of People and roles, the routing
// rule decisions of Routing rules (M2-09), and the onboarding checklist whose `pending_grants` step gives the sidebar
// badge in one request. test/screens/approvals.test.tsx compares them with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  usersList: ['GET', '/api/v1/admin/users'],
  msList: ['GET', '/api/v1/admin/management-systems'],
  auditList: ['GET', '/api/v1/admin/audit-trail'],
  rolesApprove: ['POST', '/api/v1/admin/management-systems/:id/roles/:roleId/approve'],
  rolesReject: ['POST', '/api/v1/admin/management-systems/:id/roles/:roleId/reject'],
  rulesList: ['GET', '/api/v1/admin/storage/routing-rules'],
  rulesApprove: ['POST', '/api/v1/admin/storage/routing-rules/:id/approve'],
  rulesReject: ['POST', '/api/v1/admin/storage/routing-rules/:id/reject'],
  onboarding: ['GET', '/api/v1/admin/onboarding'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  usersList: 'admin.users.list',
  msList: 'admin.ms.list',
  auditList: 'audit-trail.list',
  rolesApprove: 'admin.roles.approve',
  rolesReject: 'admin.roles.reject',
  rulesList: 'admin.storage.routing-rules.list',
  rulesApprove: 'admin.storage.routing-rules.approve',
  rulesReject: 'admin.storage.routing-rules.reject',
  onboarding: 'admin.onboarding',
};
