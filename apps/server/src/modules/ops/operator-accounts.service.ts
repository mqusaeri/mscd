// `POST /ops/users/reset-mfa` (Milestone 2 D.1, M2-06): the platform operator resets the second factor of an account
// found by its email address, typically one with active memberships in several organisations, which no single Tenant
// Admin may reset (`admin.users.reset-mfa` refuses it, F.6). As the Tenant Admin reset does (`MfaService.resetFactor`):
// the factors and recovery codes are removed, the second-factor lock is cleared and every session of the account ends;
// the account gets the security email `mfa_reset`. The audit entry `auth.mfa_reset` (platform chain, actor kind
// `operator`) carries the reason. 404 when no account has the address or it has no factor set up.
import { Inject, Injectable } from '@nestjs/common';
import type { OpsResetMfaRequest } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { AccountMailer } from '../identity/account-mailer';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { TenantScope } from '../tenancy/tenant-scope';

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
        const now = this.clock.now();
        const factors = await trx.updateTable('platform.mfa_factor').set({ deleted_at: now }).where('user_id', '=', user.id).where('deleted_at', 'is', null).executeTakeFirst();
        await trx.updateTable('platform.mfa_recovery_code').set({ deleted_at: now }).where('user_id', '=', user.id).where('deleted_at', 'is', null).execute();
        await trx.updateTable('platform.app_user').set({ mfa_failed_count: 0, mfa_locked_until: null }).where('id', '=', user.id).execute();
        const revoked = await this.sessions.revokeUserSessions(trx, user.id, 'mfa_reset');
        const memberships = await sql<{ n: string }>`
          select count(*) as n from platform.org_membership where user_id = ${user.id} and status = 'active' and deleted_at is null`.execute(trx);
        await this.audit.record(trx, {
          action: 'auth.mfa_reset',
          actor: { userId: principal.user.id, kind: 'operator' },
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
        this.mailer.sendAfterCommit(trx, { to: { email: user.email, userId: user.id }, template: { name: 'mfa_reset', link: this.mailer.appLink('/login') } });
      },
      { scope: 'operator', userId: principal.user.id, requestId: currentRequestId() },
    );
  }
}
