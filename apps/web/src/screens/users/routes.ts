// Routes of the People and roles screen (MILESTONE-2 M2-10): `[method, path]` constants for `call()` of screens/api.ts
// and the shared route ids, which test/screens/users.test.tsx compares with the route table of @mscd/shared. The
// Pending approvals screen uses the same member, system and grant routes.
import type { RouteRef } from '../api';

export const ROUTES = {
  usersList: ['GET', '/api/v1/admin/users'],
  usersCreate: ['POST', '/api/v1/admin/users'],
  usersUpdate: ['PATCH', '/api/v1/admin/users/:id'],
  usersResetMfa: ['POST', '/api/v1/admin/users/:id/reset-mfa'],
  usersIdentity: ['POST', '/api/v1/admin/users/:id/identities'],
  usersHoldings: ['GET', '/api/v1/admin/users/:id/holdings'],
  rolesGrant: ['POST', '/api/v1/admin/management-systems/:id/roles'],
  rolesApprove: ['POST', '/api/v1/admin/management-systems/:id/roles/:roleId/approve'],
  rolesReject: ['POST', '/api/v1/admin/management-systems/:id/roles/:roleId/reject'],
  rolesRevoke: ['POST', '/api/v1/admin/management-systems/:id/roles/:roleId/revoke'],
  msList: ['GET', '/api/v1/admin/management-systems'],
  idpList: ['GET', '/api/v1/admin/identity-providers'],
  orgGet: ['GET', '/api/v1/admin/organization'],
  auditList: ['GET', '/api/v1/admin/audit-trail'],
  me: ['GET', '/api/v1/me'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  usersList: 'admin.users.list',
  usersCreate: 'admin.users.create',
  usersUpdate: 'admin.users.update',
  usersResetMfa: 'admin.users.reset-mfa',
  usersIdentity: 'admin.users.identities.create',
  usersHoldings: 'admin.users.holdings',
  rolesGrant: 'admin.roles.grant',
  rolesApprove: 'admin.roles.approve',
  rolesReject: 'admin.roles.reject',
  rolesRevoke: 'admin.roles.revoke',
  msList: 'admin.ms.list',
  idpList: 'admin.idp.list',
  orgGet: 'admin.organization.get',
  auditList: 'audit-trail.list',
  me: 'me.get',
};
