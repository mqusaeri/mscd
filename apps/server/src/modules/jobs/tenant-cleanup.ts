// Tenant cleanup steps of `cleanup.expired` (E.2): other modules register a step at start (for example the auditor
// access module closes expired guest grants, F.14 step 5), and the hourly job runs every registered step inside a
// transaction of each organisation as the system user, so expiries take effect on time without the jobs module
// depending on those modules. A step runs for active organisations unless it names other statuses (Milestone 3 D.4:
// the expiry of exports also runs while an organisation is suspended, offboarding or closed).
import { Injectable } from '@nestjs/common';
import type { OrganizationStatus } from '@mscd/shared';
import type { Trx } from '../../common/tokens';

/** Statuses a step runs for when it names none. */
export const DEFAULT_STEP_STATUSES: readonly OrganizationStatus[] = ['active'];

export interface TenantCleanupStep {
  /** Name in the job's result and log lines (for example `auditorGrantsExpired`). */
  name: string;
  /** Runs in the organisation's tenant transaction; returns the number of records it ended or changed. */
  run(trx: Trx, orgId: string, now: Date): Promise<number>;
  /** Organisation statuses the step runs for (default: `active` only). */
  statuses?: readonly OrganizationStatus[];
}

/** True when the step runs for an organisation of this status. */
export function stepRunsFor(step: TenantCleanupStep, status: string): boolean {
  return (step.statuses ?? DEFAULT_STEP_STATUSES).includes(status as OrganizationStatus);
}

@Injectable()
export class TenantCleanupRegistry {
  private readonly steps = new Map<string, TenantCleanupStep>();

  /** Registers a step once per name (a second registration of a name replaces the first). */
  register(step: TenantCleanupStep): void {
    this.steps.set(step.name, step);
  }

  /** Registered steps in registration order. */
  list(): TenantCleanupStep[] {
    return [...this.steps.values()];
  }
}
