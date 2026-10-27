// RBAC expectations of the routes of M2-06: organisation settings, onboarding, account security and the operator organisation list (docs/platform/MILESTONE-2.md F).
// Owned by M2-06; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// No route of M2-06 refuses with 403 after the guard admitted the caller: the Tenant Admin, session and operator
// routes answer 200, 204, 404 or 409 to every admitted role. The factor reset of the operator gets an address no
// account has, so the sweep changes no account of the demo organisations (it answers 404).
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {
    'ops.users.reset-mfa': { params: {}, body: { email: 'nobody.m2-06@example.test', reason: 'RBAC sweep: no account has this address' } },
  },
  serviceRefusals: [],
};
