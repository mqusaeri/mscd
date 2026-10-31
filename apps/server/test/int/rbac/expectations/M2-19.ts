// RBAC expectations of the routes of M2-19: the accounts of the service and the platform operators (docs/platform/MILESTONE-2.md L).
// Owned by M2-19; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Every route is a platform route of the operator (`ops.read` to read, `ops.users.manage` to act), so every other role
// is refused by the guard, and the operator is never refused after it with 403 by these inputs. The inputs keep the
// sweep from changing the demo data: the account actions name an id no account has (404), and adding an operator names
// the system account, which the service refuses (409 `system_account`) before anything is written.
import { SYSTEM_USER_ID } from '../../../../src/common/tokens';
import type { RbacExpectations } from '../expectations';

const NOBODY = '00000000-0000-4000-8000-0000000f0019';
const REASON = 'RBAC sweep: no account has this id';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {
    'ops.accounts.reset-mfa': { params: { id: NOBODY }, body: { reason: REASON } },
    'ops.accounts.password-reset': { params: { id: NOBODY }, body: { reason: REASON } },
    'ops.accounts.invitation-resend': { params: { id: NOBODY, org: 'ndt' }, body: { reason: REASON } },
    'ops.accounts.sessions-revoke': { params: { id: NOBODY }, body: { reason: REASON } },
    'ops.accounts.status': { params: { id: NOBODY }, body: { status: 'disabled', reason: REASON } },
    'ops.operators.add': { params: {}, body: { email: 'system@mscd.invalid', name: 'System', reason: 'RBAC sweep: the system account is refused' } },
    'ops.operators.remove': { params: { id: SYSTEM_USER_ID }, body: { reason: 'RBAC sweep: the system account is refused' } },
  },
  serviceRefusals: [],
};
