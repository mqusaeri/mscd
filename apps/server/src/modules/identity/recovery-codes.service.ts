// New recovery codes and the security overview of the session user (Milestone 2 D.1, M2-06):
// - `POST /me/mfa/recovery-codes`: ten new codes while the authenticator stays. The current authenticator code is
//   needed unless the session proved the second factor in the last 5 minutes (F.5 `RECENT_PROOF_MS`); a wrong code
//   counts towards the second-factor lock like any other (F.3) and is committed. The old unused codes stop working,
//   the change is audited (`auth.recovery_codes_regenerated`) and the user gets the security email. The codes are
//   shown once and only their argon2id hashes are stored.
// - `GET /me/security` (through `MeService`): password set, sign-in only through a provider, authenticator set up at,
//   recovery codes left and the linked identities. It runs with platform scope, because the identity providers of the
//   user's other organisations are hidden from an organisation transaction (D-31).
// Refusals of the code check answer 422 `business-rule` with the message keys of enrolment (`auth.proof_required`,
// `auth.proof_invalid`): a 401 would tell the web app that the session ended.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { MeSecurity, RecoveryCodesRequest, RecoveryCodesResponse } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { ConflictError, ProblemError, RateLimitedError, UnauthenticatedError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Trx } from '../../common/tokens';
import { TenantScope } from '../tenancy/tenant-scope';
import { AccountMailer } from './account-mailer';
import { decideLocalLogin } from './local-login-policy';
import { MfaService, hasRecentSecondFactorProof } from './mfa.service';
import { hashSecret } from './password-hasher';
import { newRecoveryCodes, recoveryCodeKey, RECOVERY_CODE_COUNT } from './recovery-codes';
import { SessionService, type SessionRow } from './session.service';

function proofProblem(messageKey: 'auth.proof_required' | 'auth.proof_invalid'): ProblemError {
  const required = messageKey === 'auth.proof_required';
  const en = required ? 'Enter the current code of your authenticator app to get new recovery codes.' : 'The code of your authenticator app is not valid.';
  const id = required
    ? 'Masukkan kode saat ini dari aplikasi autentikator Anda untuk mendapatkan kode pemulihan baru.'
    : 'Kode dari aplikasi autentikator Anda tidak valid.';
  return new ProblemError('business-rule', { messageKey, detail: en, messages: { en, id }, errors: [{ path: 'body.code', message: en }] });
}

@Injectable()
export class RecoveryCodesService {
  constructor(
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly mailer: AccountMailer,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    // Optional like the database services of IdentityInfra: an application without TenancyModule (unit tests of the
    // HTTP layer) still starts; the routes need them.
    @Optional() private readonly tenantScope?: TenantScope,
    @Optional() private readonly clockService?: Clock,
  ) {}

  private get scope(): TenantScope {
    if (!this.tenantScope) throw new Error('RecoveryCodesService needs TenantScope: import TenancyModule');
    return this.tenantScope;
  }

  private get clock(): Clock {
    if (!this.clockService) throw new Error('RecoveryCodesService needs Clock: import CommonModule');
    return this.clockService;
  }

  /** `POST /me/mfa/recovery-codes`. */
  async regenerate(request: FastifyRequest, _reply: FastifyReply, body: RecoveryCodesRequest): Promise<RecoveryCodesResponse> {
    const current = this.sessions.currentOf(request);
    if (!current) throw new UnauthenticatedError();
    const row: SessionRow = current.row;
    const userId = row.user_id;
    const now = this.clock.now();
    // The costly hashing happens before the transaction that holds the user's row lock.
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashSecret(recoveryCodeKey(c))));

    const error = await this.scope.withPlatform(
      async (trx): Promise<Error | null> => {
        const user = await trx.selectFrom('platform.app_user').select(['id', 'email', 'kind']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
        if (!(await this.sessions.isOpen(trx, row.id_hash))) return new UnauthenticatedError();
        if (!(await this.mfa.hasConfirmedFactor(trx, userId))) {
          return new ConflictError('Your account has no authenticator app yet; set one up first', { messageKey: 'auth.no_authenticator' });
        }
        if (body.code !== undefined) {
          // Checked like a sign-in code: replay protection, failures and the lock are recorded and committed.
          const result = await this.mfa.checkSecondFactor(trx, userId, { code: body.code }, { organizationId: row.auth_org_id });
          if (result.kind === 'locked') {
            return new RateLimitedError(Math.max(1, Math.ceil((result.until.getTime() - now.getTime()) / 1000)), 'Two-step sign-in is locked after too many wrong codes; try again later');
          }
          if (result.kind === 'failed') return proofProblem('auth.proof_invalid');
          await this.sessions.touchProof(trx, row.id_hash, { mfaAt: now });
        } else if (!hasRecentSecondFactorProof(row, now)) {
          return proofProblem('auth.proof_required');
        }

        const replaced = await trx
          .updateTable('platform.mfa_recovery_code')
          .set({ deleted_at: now })
          .where('user_id', '=', userId)
          .where('used_at', 'is', null)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        await trx
          .insertInto('platform.mfa_recovery_code')
          .values(hashes.map((code_hash) => ({ user_id: userId, code_hash })))
          .execute();
        await this.audit.record(trx, {
          action: 'auth.recovery_codes_regenerated',
          actor: { userId, kind: user.kind === 'guest' ? 'guest' : 'user' },
          organizationId: row.auth_org_id,
          entityType: 'user',
          entityId: userId,
          after: { recoveryCodes: RECOVERY_CODE_COUNT, replacedUnused: Number(replaced.numUpdatedRows) },
        });
        this.mailer.sendAfterCommit(trx, { to: { email: user.email, userId }, template: { name: 'recovery_codes_regenerated', link: this.mailer.appLink('/') } });
        return null;
      },
      { scope: 'auth', userId, orgId: row.auth_org_id },
    );
    if (error) throw error;
    return { codes };
  }

  /** The security overview of `GET /me/security` for a user. */
  overview(userId: string): Promise<MeSecurity> {
    return this.scope.withPlatform(
      async (trx) => {
        const user = await trx.selectFrom('platform.app_user').select(['password_hash', 'kind']).where('id', '=', userId).executeTakeFirstOrThrow();
        const factor = await trx
          .selectFrom('platform.mfa_factor')
          .select('confirmed_at')
          .where('user_id', '=', userId)
          .where('confirmed_at', 'is not', null)
          .where('deleted_at', 'is', null)
          .orderBy('confirmed_at', 'desc')
          .executeTakeFirst();
        const codes = await this.codesLeft(trx, userId);
        const identities = await trx
          .selectFrom('platform.user_identity as i')
          .innerJoin('platform.identity_provider as p', 'p.id', 'i.identity_provider_id')
          .select(['p.slug', 'p.kind', 'p.display_name', 'i.linked_at'])
          .where('i.user_id', '=', userId)
          .where('p.deleted_at', 'is', null)
          .orderBy('i.linked_at')
          .execute();
        const local = user.kind === 'guest' ? null : (await decideLocalLogin(trx, userId)).allowed;
        return {
          passwordSet: user.password_hash !== null,
          ssoOnly: local === null,
          authenticatorSetUpAt: factor?.confirmed_at ? factor.confirmed_at.toISOString() : null,
          recoveryCodesLeft: Math.min(RECOVERY_CODE_COUNT, codes),
          identities: identities.map((i) => ({ provider: i.slug, kind: i.kind, label: i.display_name, linkedAt: i.linked_at.toISOString() })),
        };
      },
      { scope: 'auth', userId },
    );
  }

  /** Unused recovery codes of the user. */
  private async codesLeft(trx: Trx, userId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from platform.mfa_recovery_code where user_id = ${userId} and used_at is null and deleted_at is null`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }
}
