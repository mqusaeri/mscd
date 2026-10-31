// Status changes of an organisation by the platform operator (Milestone 2 D.1 `ops.organizations.status`, J.4, J.8,
// K.6; M2-S09), also behind the command `tenant set-status`. Multi tenancy only (single tenancy answers 409 `conflict`
// with messageKey `single_tenancy`, J.6).
//
// Milestone 3 (D.2, D.5, J.8; M3-03): the machine gains the end of contract. The move to offboarding sets the end of the
// read-only period and queues the final export, the move to archived schedules the verified deletion, archived returns
// to offboarding while its deletion is scheduled (which cancels it), and deleted is reached by the purge only. The moves
// live in `deletion/organization-transitions.ts`, which `org.lifecycle` (the system's move at the end of the read-only
// period) and `tenant purge --reapply` use too; this service is the operator's entry point.
import { Injectable } from '@nestjs/common';
import type { OrganizationStatusChange } from '@mscd/shared';
import { OrganizationTransitions, type StatusChangeOutcome } from './deletion/organization-transitions';
import type { OperatorActor } from './organizations.service';

export { allowedMoves, confirmationMismatch, invalidStatusTransition, type MoveContext, type StatusChangeOutcome } from './deletion/organization-transitions';

@Injectable()
export class OrganizationStatusService {
  constructor(private readonly transitions: OrganizationTransitions) {}

  /** `POST /ops/organizations/{org}/status`, and `tenant set-status` with `CLI_OPERATOR`. */
  change(actor: OperatorActor, slug: string, body: OrganizationStatusChange): Promise<StatusChangeOutcome> {
    return this.transitions.operatorMove(actor, slug, body);
  }
}
