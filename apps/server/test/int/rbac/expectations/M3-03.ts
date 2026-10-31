// RBAC expectations of the routes of M3-03: end of contract and verified deletion (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-03; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Nothing to add: the five `ops.deletion.*` routes are platform routes of the operator (`ops.read`,
// `ops.tenants.manage`), so every other role is refused by the guard, and the operator is never refused after it. In
// single tenancy every route answers 409 `single_tenancy` (J.6) before it reads its input; in multi tenancy the schema
// examples name an active demo organisation, so the service answers 404 (no deletion) or 409 `deletion_not_archived`
// and changes nothing. test/int/org-deletion covers the routes themselves.
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
