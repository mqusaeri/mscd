// RBAC expectations of the routes of M2-08: bulk import (docs/platform/MILESTONE-2.md F).
// Owned by M2-08; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// `imports.create` admits holders of the kind's permission for their own records (`risk.manage` of a Risk Owner,
// `evidence.manage` of a Domain Owner or Risk Owner). The service then refuses risks with 403 `imports.permission`,
// because creating a risk needs `risk.manage` in full; evidence is imported with the caller as the owner. That refusal
// is not listed under `serviceRefusals`: the refusal test checks the matrix with the `kind` of the route's first
// sweep input (`applicability`), which a Risk Owner does not hold, so `test/int/imports/imports.test.ts` covers it.
// `imports.get` and `imports.commit` answer 404 to anyone but the creator, which the sweep's example ids already get.
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [],
};
