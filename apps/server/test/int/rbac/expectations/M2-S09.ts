// RBAC expectations of the routes of M2-S09: the organisation detail, status changes and status history of the operator (docs/platform/MILESTONE-2.md F).
// Owned by M2-S09; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Nothing to add: the three routes are platform routes of the operator (`ops.read`, `ops.tenants.manage`), so every
// other role is refused by the guard, and the operator is never refused after it. In single tenancy, where the sweeps
// run, every route answers 409 `single_tenancy` (J.6) before it reads its input, so the schema examples change no
// organisation; in multi tenancy test/int/saas-ops covers them (404 for an unknown organisation, 409
// `invalid_status_transition`, 422 `confirmation_mismatch`).
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
