// RBAC expectations of the routes of M3-06: retention and disposal review (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-06; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive. Written empty by M3-01.
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
