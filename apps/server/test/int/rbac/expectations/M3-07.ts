// RBAC expectations of the routes of M3-07: periodic access review (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-07; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive. Written empty by M3-01; M3-07 needs no input
// override (the example ids reach every handler, which answers 404 for an unknown review or item) and no service
// refusal (the services refuse nothing with 403 for a role the guard admits).
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
