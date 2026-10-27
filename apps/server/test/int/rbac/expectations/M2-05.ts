// RBAC expectations of the routes of M2-05: certification cycles and the internal audit programme (docs/platform/MILESTONE-2.md F).
// Owned by M2-05; merged by ../expectations.ts. The guard decisions of every route come from the F.6 matrix and the
// route table; this file only adds what the generated sweep cannot derive.
//
// Milestone 2 D.2: `audit-events.update`, `audit-activities.generate` and `audit-activities.update` admit holders of
// `internal_audit.manage` [MM, IA] at the guard. Without `audit_event.manage` the services refuse an event that is
// not an internal audit, and a change of an internal audit's event type (M2-02 interim check, kept by M2-05).
import { addAuditActivity, addAuditEvent } from '../../contract/harness';
import type { RbacExpectations } from '../expectations';

export const RBAC_EXPECTATIONS: RbacExpectations = {
  inputs: {},
  serviceRefusals: [
    {
      route: 'audit-events.update',
      role: 'IA',
      reason: 'an Internal Auditor changes an audit event that is not an internal audit (D.2)',
      setup: async (db) => ({ params: { id: await addAuditEvent(db, 'tst', 'isms', 'stage1') } }),
    },
    {
      route: 'audit-events.update',
      role: 'IA',
      reason: 'an Internal Auditor turns an internal audit into a certification audit (D.2)',
      setup: async (db) => ({ params: { id: await addAuditEvent(db, 'tst', 'isms', 'internal_audit') }, body: { eventType: 'stage2' } }),
    },
    {
      route: 'audit-activities.generate',
      role: 'IA',
      reason: 'an Internal Auditor generates the activities of an audit event that is not an internal audit (D.2)',
      setup: async (db) => ({ params: { id: await addAuditEvent(db, 'tst', 'isms', 'surveillance') } }),
    },
    {
      route: 'audit-activities.update',
      role: 'IA',
      reason: 'an Internal Auditor plans an activity of an audit event that is not an internal audit (D.2)',
      setup: async (db) => ({ params: { id: await addAuditActivity(db, 'tst', await addAuditEvent(db, 'tst', 'isms', 'stage2')) } }),
    },
  ],
};
