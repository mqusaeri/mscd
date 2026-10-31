// The second-factor reset of the platform operator (Milestone 2 D.1). Two routes use it:
// - `POST /ops/users/reset-mfa` (M2-06, kept for `saas-ops.sh`): the account is found by its email address, typically
//   one with active memberships in several organisations, which no single Tenant Admin may reset
//   (`admin.users.reset-mfa` refuses it, F.6). 404 when no account has the address or it has no factor set up.
// - `POST /ops/accounts/{id}/reset-mfa` (M2-19, the Accounts screen): the account is named by its id
//   (`OpsAccountsService`).
// As the Tenant Admin reset does (`MfaService.resetFactor`): the factors and recovery codes are removed, the
// second-factor lock is cleared and every session of the account ends; the account gets the security email
// `mfa_reset` (after the commit; the Accounts route sends it itself and answers whether it went out). The audit entry
// `auth.mfa_reset` (platform chain, actor kind `operator`) carries the reason.
import { Inject, Injectable } from '@nestjs/common';
import type { OpsResetMfaRequest } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { AccountMailer, type AccountMail } from '../identity/account-mailer';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { TenantScope } from '../tenancy/tenant-scope';

/** The account whose factor is reset. */
export interface ResetTarget {
  id: string;
  email: string;
  handle: string;
}

@Injectable()
export class OperatorAccountsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly mailer: AccountMailer,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `POST /ops/users/reset-mfa`: the account found by its email address. */
  async resetMfa(principal: Principal, body: OpsResetMfaRequest): Promise<void> {
    const email = body.email.trim().toLowerCase();
    const reason = body.reason.trim();
    await this.scope.withPlatform(
      async (trx) => {
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'email', 'handle'])
          .where(sql<string>`lower(email)`, '=', email)
          .where('kind', '<>', 'system')
          .where('deleted_at', 'is', null)
          .orderBy(sql`kind = 'person'`, 'desc')
          .forUpdate()
          .executeTakeFirst();
        if (!user) throw new NotFoundError('No account has this email address');
        if (!(await this.mfa.hasConfirmedFactor(trx, user.id))) throw new NotFoundError('The account has no second factor set up');
        await this.resetFactorOf(trx, principal.user.id, user, reason);
      },
      { scope: 'operator', userId: principal.user.id, requestId: currentRequestId() },
    );
  }

  /** The security email `mfa_reset` to the account whose factor was reset. */
  resetMail(user: ResetTarget): AccountMail {
    return { to: { email: user.email, userId: user.id }, template: { name: 'mfa_reset', link: this.mailer.appLink('/login') } };
  }

  /**
   * Removes the factors and recovery codes of `user`, clears its second-factor lock, ends its sessions and audits
   * `auth.mfa_reset` with the reason. Runs in the caller's platform-scope transaction, which holds the account row;
   * returns the sessions it ended. With `mail: 'after_commit'` (the default) the email `mfa_reset` goes out after the
   * commit and nobody learns whether it did; with `mail: 'caller'` the caller sends `resetMail(user)` after the commit.
   */
  async resetFactorOf(trx: Trx, operatorId: string, user: ResetTarget, reason: string, mail: 'after_commit' | 'caller' = 'after_commit'): Promise<number> {
    const now = this.clock.now();
    const factors = await trx.updateTable('platform.mfa_factor').set({ deleted_at: now }).where('user_id', '=', user.id).where('deleted_at', 'is', null).executeTakeFirst();
    await trx.updateTable('platform.mfa_recovery_code').set({ deleted_at: now }).where('user_id', '=', user.id).where('deleted_at', 'is', null).execute();
    await trx.updateTable('platform.app_user').set({ mfa_failed_count: 0, mfa_locked_until: null }).where('id', '=', user.id).execute();
    const revoked = await this.sessions.revokeUserSessions(trx, user.id, 'mfa_reset');
    const memberships = await sql<{ n: string }>`
      select count(*) as n from platform.org_membership where user_id = ${user.id} and status = 'active' and deleted_at is null`.execute(trx);
    await this.audit.record(trx, {
      action: 'auth.mfa_reset',
      actor: { userId: operatorId, kind: 'operator' },
      organizationId: null,
      entityType: 'user',
      entityId: user.id,
      entityCode: user.handle,
      after: {
        reason,
        by: 'platform_operator',
        factorsRemoved: Number(factors.numUpdatedRows),
        sessionsRevoked: revoked,
        activeMemberships: Number(memberships.rows[0]?.n ?? 0),
      },
    });
    if (mail === 'after_commit') this.mailer.sendAfterCommit(trx, this.resetMail(user));
    return revoked;
  }
}
