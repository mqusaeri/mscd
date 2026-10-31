// AccountAnonymiser (Milestone 3 D.5.2 step 3, D.6.5; built by M3-03, reused by M3-04 for the erasure of a person).
//
// Records and audit rows refer to an account by its id (`created_by`, owner columns, `actor_user_id`), so an account is
// never deleted: it is anonymised and its row kept. The anonymiser runs in the caller's transaction with platform scope
// switched on for its statements (`inPlatformScope`), so it commits with the purge step or the erasure that calls it:
//   - email `<new handle>@erased.invalid`, handle `erased-<8 hex>`, display name "Former user", job title cleared;
//   - password hash, password date, failed sign-in counters and locks cleared; status `disabled`; `erased_at` set;
//   - second factors, recovery codes, linked company sign-in, sessions, invitations, password reset tokens and
//     preferences deleted (secret_sealed and code_hash are NOT NULL, so these rows go, D.3);
//   - audited `user.anonymised` in the platform chain with the reason and the new handle, never the old values.
// It refuses (returns null for) the system account and platform operators, and accounts that still hold a membership of
// another organisation unless the caller says which organisation it removes them from (`leavingOrgId`): those keep
// everything except that organisation's membership, which the caller ends.
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';
import { IdentityInfra } from './identity-infra';
import { inPlatformScope } from './platform-scope';

/** Display name of an anonymised account (D.5.2 step 3). */
export const ANONYMISED_DISPLAY_NAME = 'Former user';
/** Domain of the email of an anonymised account (`.invalid` never resolves, RFC 2606). */
export const ANONYMISED_EMAIL_DOMAIN = 'erased.invalid';

/** A new handle of an anonymised account: `erased-` and 8 hex characters (the handle check of app_user accepts it). */
export function newErasedHandle(): string {
  return `erased-${randomBytes(4).toString('hex')}`;
}

/** Why an account cannot be anonymised now. */
export type AnonymiseRefusal = 'unknown' | 'system' | 'operator' | 'other_membership' | 'already';

export interface AnonymiseInput {
  /** Why (recorded in the audit entry, at most 200 characters). */
  reason: string;
  /** The organisation the audit entry belongs to (the purged organisation, or the one that erased the person). */
  organizationId: string | null;
  /**
   * The organisation whose membership ends with this step: memberships of that organisation do not count as "another
   * membership". Every other membership that is not removed (`deleted_at` null) keeps the account.
   */
  leavingOrgId?: string | null;
  actor?: { userId: string | null; kind: 'user' | 'system' | 'operator' };
}

export interface AnonymisedAccount {
  userId: string;
  /** The new handle (`erased-<8 hex>`), which is also the pseudonym of the account in redacted audit entries. */
  handle: string;
  /** Rows removed per kind (second factors, recovery codes, identities, sessions, invitations, tokens, preferences). */
  removed: Record<string, number>;
}

@Injectable()
export class AccountAnonymiser {
  // The clock and the audit writer come through IdentityInfra like every identity service, so the request-pipeline
  // test applications that load the identity module alone still start.
  constructor(private readonly infra: IdentityInfra) {}

  /** Why the account may not be anonymised now, or null when it may. */
  async refusal(trx: Trx, userId: string, leavingOrgId: string | null = null): Promise<AnonymiseRefusal | null> {
    return inPlatformScope(trx, async () => {
      const user = await trx.selectFrom('platform.app_user').select(['kind', 'erased_at']).where('id', '=', userId).executeTakeFirst();
      if (!user) return 'unknown';
      if (user.kind === 'system' || userId === SYSTEM_USER_ID) return 'system';
      if (user.erased_at !== null) return 'already';
      const operator = await trx
        .selectFrom('platform.platform_role')
        .select('user_id')
        .where('user_id', '=', userId)
        .where('role', '=', 'platform_operator')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (operator) return 'operator';
      let others = trx
        .selectFrom('platform.org_membership')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null);
      if (leavingOrgId) others = others.where('organization_id', '<>', leavingOrgId);
      const counted = await others.executeTakeFirstOrThrow();
      return Number(counted.n) > 0 ? 'other_membership' : null;
    });
  }

  /** Anonymises the account in `trx`; null (and nothing changed) when `refusal` names a reason. */
  async anonymise(trx: Trx, userId: string, input: AnonymiseInput): Promise<AnonymisedAccount | null> {
    if ((await this.refusal(trx, userId, input.leavingOrgId ?? null)) !== null) return null;
    const now = this.infra.clock.now();
    const result = await inPlatformScope(trx, async () => {
      // A handle no account holds yet (8 hex characters: a clash is rare, so a few attempts are enough).
      let handle = newErasedHandle();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', handle).executeTakeFirst();
        if (!taken) break;
        handle = newErasedHandle();
      }
      await trx
        .updateTable('platform.app_user')
        .set({
          handle,
          email: `${handle}@${ANONYMISED_EMAIL_DOMAIN}`,
          display_name: ANONYMISED_DISPLAY_NAME,
          job_title: null,
          password_hash: null,
          password_changed_at: null,
          failed_login_count: 0,
          locked_until: null,
          mfa_failed_count: 0,
          mfa_lock_level: 0,
          mfa_locked_until: null,
          last_login_at: null,
          status: 'disabled',
          erased_at: now,
          updated_at: now,
        })
        .where('id', '=', userId)
        .execute();
      const removed: Record<string, number> = {};
      const count = (n: bigint | undefined) => Number(n ?? 0n);
      removed.secondFactors = count((await trx.deleteFrom('platform.mfa_factor').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.recoveryCodes = count((await trx.deleteFrom('platform.mfa_recovery_code').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.linkedSignIns = count((await trx.deleteFrom('platform.user_identity').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.sessions = count((await trx.deleteFrom('platform.session').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.invitations = count((await trx.deleteFrom('platform.invitation').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.passwordTokens = count((await trx.deleteFrom('platform.password_reset_token').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      removed.preferences = count((await trx.deleteFrom('platform.user_preference').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
      return { handle, removed };
    });
    await this.infra.audit.record(trx, {
      action: 'user.anonymised',
      actor: input.actor ?? { userId: SYSTEM_USER_ID, kind: 'system' },
      organizationId: input.organizationId,
      entityType: 'user',
      entityId: userId,
      entityCode: result.handle,
      after: { reason: input.reason.slice(0, 200), erasedAt: now.toISOString(), removed: result.removed },
      sourceIp: null,
      userAgent: null,
    });
    return { userId, handle: result.handle, removed: result.removed };
  }

  /** Accounts in `userIds` that are anonymised as the check of D.5.3 expects (no email, name or secret left). */
  async leftovers(trx: Trx, userIds: readonly string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    return inPlatformScope(trx, async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from platform.app_user u
         where u.id = any(${[...userIds]}::uuid[])
           and (u.erased_at is null or u.email not like ${`%@${ANONYMISED_EMAIL_DOMAIN}`} or u.display_name <> ${ANONYMISED_DISPLAY_NAME}
                or u.job_title is not null or u.password_hash is not null
                or exists (select 1 from platform.mfa_factor f where f.user_id = u.id)
                or exists (select 1 from platform.mfa_recovery_code c where c.user_id = u.id)
                or exists (select 1 from platform.user_identity i where i.user_id = u.id)
                or exists (select 1 from platform.user_preference p where p.user_id = u.id)
                or exists (select 1 from platform.password_reset_token t where t.user_id = u.id))`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    });
  }
}
