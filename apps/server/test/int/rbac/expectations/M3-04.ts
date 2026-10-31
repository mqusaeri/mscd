// RBAC expectations of the routes of M3-04: requests from one person (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-04; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive. Written empty by M3-01; M3-04 needs no input
// override (the examples reach every handler, which answers 404 for the example ids) and no service refusal (the one
// 403 of the services, restricting or erasing one's own membership, needs a request about the caller, which the
// examples never name; test/int/privacy covers it).
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
