// RBAC expectations of the routes of M2-S11: email domains (docs/platform/MILESTONE-2.md F).
// Owned by M2-S11; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Nothing to add: the four routes are platform routes of the operator (`ops.read` for the list, `ops.tenants.manage`
// for add, verify and remove), so every other role is refused by the guard, and the operator is never refused after it.
// In single tenancy, where the sweeps run, every route answers 409 `single_tenancy` (J.6) before it reads its input;
// test/int/domains covers them in multi tenancy.
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
