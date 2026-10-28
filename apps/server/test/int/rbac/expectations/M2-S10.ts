// RBAC expectations of the routes of M2-S10: entitlements and plan presets (docs/platform/MILESTONE-2.md F).
// Owned by M2-S10; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Nothing to add: the three routes are platform routes of the operator (`ops.read`, `ops.entitlements.manage`), so
// every other role is refused by the guard, and the operator is never refused after it. In single tenancy, where the
// sweeps run, every route answers 409 `single_tenancy` (J.6) before reading its input; in multi tenancy the schema
// examples reach the handler (200, 404 for an unknown organisation, 412 or 428 for `If-Match`).
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
