// Expected guard decisions of the generated RBAC tests (build plan J.5, F.6, F.7), derived from the F.6 matrix as
// data (`PERMISSION_MATRIX`) and the route table, for a user who holds exactly one role. The rules are written out
// here instead of calling the server's evaluator, so the suite checks the wiring of every route (permission, scope,
// system source, alternatives, machine rows) and the guard pipeline against the plan. The grants are those of the
// run's tenancy mode (test/setup/tenancy.ts): single in `test:int`, multi in `test:int:saas` (Milestone 2 J.2, M2-S13).
import {
  EXTERNAL_AUDITOR, effectiveGrant, machinePermissions, permissionCase, type Permission, type PermissionCheckScope, type RouteDef,
} from '@mscd/shared';
import type { TestDatabase } from '../../setup/test-db';
import { testTenancy } from '../../setup/tenancy';
import { BUSINESS_ROLE, ORG_ROLE, type RoleKey, type RouteInput } from '../contract/harness';
import { RBAC_EXPECTATIONS as M2_05 } from './expectations/M2-05';
import { RBAC_EXPECTATIONS as M2_06 } from './expectations/M2-06';
import { RBAC_EXPECTATIONS as M2_07 } from './expectations/M2-07';
import { RBAC_EXPECTATIONS as M2_08 } from './expectations/M2-08';
import { RBAC_EXPECTATIONS as M2_19 } from './expectations/M2-19';
import { RBAC_EXPECTATIONS as M2_S09 } from './expectations/M2-S09';
import { RBAC_EXPECTATIONS as M2_S10 } from './expectations/M2-S10';
import { RBAC_EXPECTATIONS as M2_S11 } from './expectations/M2-S11';
import { RBAC_EXPECTATIONS as M3_02 } from './expectations/M3-02';
import { RBAC_EXPECTATIONS as M3_03 } from './expectations/M3-03';
import { RBAC_EXPECTATIONS as M3_04 } from './expectations/M3-04';
import { RBAC_EXPECTATIONS as M3_05 } from './expectations/M3-05';
import { RBAC_EXPECTATIONS as M3_06 } from './expectations/M3-06';
import { RBAC_EXPECTATIONS as M3_07 } from './expectations/M3-07';

/**
 * What a Milestone 2 building package adds to the generated RBAC tests (Milestone 2 F), in `expectations/M2-nn.ts`
 * (or `M2-Snn.ts`), so no two packages share a file:
 * - `inputs`: a request input per route id that replaces the one built from the schema examples, when the examples
 *   cannot reach the handler (for example a record id the route needs);
 * - `serviceRefusals`: requests the guard admits and the service refuses with 403, because the rule depends on the
 *   record (for example an Internal Auditor on an audit event that is not an internal audit, Milestone 2 D.2).
 *   `setup` prepares the record in the demo organisation `tst` (system `isms`) and returns the members that replace
 *   those of the route's first sweep input (path parameters merged, body and query replaced).
 */
export interface ServiceRefusal {
  route: string;
  role: RoleKey;
  reason: string;
  setup?: (db: TestDatabase) => Promise<RouteInput>;
}

export interface RbacExpectations {
  inputs: Readonly<Record<string, RouteInput>>;
  serviceRefusals: readonly ServiceRefusal[];
}

/**
 * The RBAC expectations of the Milestone 2 building packages and, in the same form, of the Milestone 3 building
 * packages M3-02 to M3-07 (`expectations/M3-nn.ts`, Milestone 3 D.3), by package.
 */
export const M2_EXPECTATIONS: Readonly<Record<string, RbacExpectations>> = {
  'M2-05': M2_05, 'M2-06': M2_06, 'M2-07': M2_07, 'M2-08': M2_08, 'M2-19': M2_19, 'M2-S09': M2_S09, 'M2-S10': M2_S10, 'M2-S11': M2_S11,
  'M3-02': M3_02, 'M3-03': M3_03, 'M3-04': M3_04, 'M3-05': M3_05, 'M3-06': M3_06, 'M3-07': M3_07,
};

/** Input overrides of the Milestone 2 packages, by route id. */
export const M2_INPUTS: Readonly<Record<string, RouteInput>> = Object.assign({}, ...Object.values(M2_EXPECTATIONS).map((e) => e.inputs));

/** Service refusals of the Milestone 2 packages. */
export const M2_SERVICE_REFUSALS = Object.values(M2_EXPECTATIONS).flatMap((e) => e.serviceRefusals);

export interface Check {
  permission: Permission;
  scope: PermissionCheckScope;
}

/** Whether a user holding only `role` (business roles in the request's system) passes one check (F.6, F.7). */
export function roleHolds(role: RoleKey, check: Check): boolean {
  const grant = effectiveGrant(check.permission, testTenancy());
  if (role === 'OP') return grant.platformRoles.includes('platform_operator');
  if (check.scope === 'platform' || grant.scope === 'platform') return false;
  const orgRole = ORG_ROLE[role];
  if (orgRole && grant.orgRoles.includes(orgRole)) return true;
  const business = BUSINESS_ROLE[role];
  if (!business) return false;
  switch (check.scope) {
    case 'org':
      // "MM of any system" rows; the external auditor role never counts outside the audited system.
      return business !== EXTERNAL_AUDITOR && grant.anyMsRoles.includes(business);
    case 'any_ms':
      return business !== EXTERNAL_AUDITOR && (grant.roles.includes(business) || grant.own.includes(business));
    case 'ms':
      return grant.roles.includes(business) || grant.own.includes(business);
    default:
      return false;
  }
}

/** The checks the guard makes for a request (`member` is the value of a `permissionBy` member). */
export function checksOf(def: RouteDef, member?: unknown): { any: Check[]; all: Check[] } {
  const scopeOf = (permission: Permission, scope?: PermissionCheckScope): PermissionCheckScope => scope ?? effectiveGrant(permission, testTenancy()).scope;
  if (def.permissionBy) {
    const c = permissionCase(def.permissionBy, member);
    return { any: [{ permission: c.permission, scope: c.scope }], all: [] };
  }
  const any: Check[] = [];
  const add = (permission: Permission, scope?: PermissionCheckScope) => {
    const s = scopeOf(permission, scope);
    if (!any.some((c) => c.permission === permission && c.scope === s)) any.push({ permission, scope: s });
  };
  if (def.permission) add(def.permission, def.scope as PermissionCheckScope | undefined);
  for (const alt of def.anyOf ?? []) add(alt.permission, alt.scope);
  if (def.machine) for (const p of machinePermissions(def.machine)) add(p, 'ms');
  const all = (def.allOf ?? []).map((p) => ({ permission: p, scope: scopeOf(p, def.scope as PermissionCheckScope | undefined) }));
  return { any, all };
}

/** True for routes the guard treats as business routes (everything but sign-in steps and the user's own session). */
export function isBusinessRoute(def: RouteDef): boolean {
  return def.auth !== 'public' && !def.path.startsWith('/api/v1/auth/') && !def.id.startsWith('me.');
}

/**
 * True when the guard admits a user who holds only `role` (F.6, F.7). `namesSystem` says whether the request names
 * a system: an ms-scoped check of a request without one fails (F.7, WP-05 contract).
 */
export function expectedAllowed(def: RouteDef, role: RoleKey, member?: unknown, namesSystem = true): boolean {
  // External auditors (accounts whose only role is the auditor role) never change anything on business routes.
  if (role === 'EA' && def.method !== 'GET' && isBusinessRoute(def)) return false;
  const { any, all } = checksOf(def, member);
  if (any.length === 0 && all.length === 0) return true;
  const holds = (c: Check) => (c.scope !== 'ms' || namesSystem) && roleHolds(role, c);
  if (!any.some(holds)) return false;
  return all.every(holds);
}
