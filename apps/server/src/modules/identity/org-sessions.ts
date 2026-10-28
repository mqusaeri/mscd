// Session revocation per organisation for the organisation lifecycle of the SaaS track (Milestone 2 K.6, J.8,
// M2-S09). When the platform operator moves an organisation to `suspended` or `archived`, every session whose current
// organisation is this one ends in the same transaction as the status change. A session whose current organisation is
// another one keeps working, also when it was opened through this organisation's sign-in policy, so people keep their
// other memberships: they sign in again and land in an organisation that is still active (BP F.1, D-26).
//
// The revocation runs in the caller's transaction with platform scope (`inPlatformScope`), as every write of
// `platform.session` from another module does. Each process reads `platform.session` on every request (the session
// resolver keeps no cache of its own), so a revoked session ends at its next request in every api process; the
// organisation's cached status is dropped by the change notice (`publishTenantChange`) that the status change sends.
import { Injectable, Optional } from '@nestjs/common';
import { Clock } from '../../common/clock';
import type { Trx } from '../../common/tokens';
import { inPlatformScope } from './platform-scope';

/** `platform.session.revoke_reason` of a session ended by an organisation status change (varchar(40)). */
export type OrganisationSessionRevokeReason = 'organisation_suspended' | 'organisation_archived';

/** The revoke reason of a status change, or null when the status keeps the sessions (`active`, `offboarding`). */
export function revokeReasonOfStatus(status: string): OrganisationSessionRevokeReason | null {
  if (status === 'suspended') return 'organisation_suspended';
  if (status === 'archived') return 'organisation_archived';
  return null;
}

@Injectable()
export class OrgSessions {
  constructor(@Optional() private readonly clock?: Clock) {}

  /**
   * Ends every open session whose current organisation is `orgId`, in `trx`; returns how many were open. Guest
   * sessions of auditor grants in the organisation count too.
   */
  async revokeCurrentOrganisation(trx: Trx, orgId: string, reason: OrganisationSessionRevokeReason): Promise<number> {
    const now = this.clock?.now() ?? new Date();
    const result = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: reason })
        .where('organization_id', '=', orgId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /** Open sessions whose current organisation is `orgId` (operator views and tests). */
  async countCurrentOrganisation(trx: Trx, orgId: string): Promise<number> {
    const row = await inPlatformScope(trx, () =>
      trx
        .selectFrom('platform.session')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', orgId)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }
}
