// Linked company sign-in of a member (Milestone 3 D.1 `admin.users.identities.remove`, D.9, M3-07). A Tenant Admin
// removes the `platform.user_identity` rows that link a member's account to one of this organisation's identity
// providers (by its slug): the person can no longer sign in through that provider until it is linked again
// (pre-registration of D-25 or a link from a session). The sessions the person signed in through that provider end at
// once (F.1), in the same transaction. Audited `identity.unlinked` in the platform log of the organisation (F.11),
// with the provider, the removed subjects, the reason and the number of sessions ended. Used by the route and by the
// access review, which applies a decided `linked_sign_in` revocation through this service.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal, type Trx } from '../../common/tokens';
import { inPlatformScope } from '../identity/platform-scope';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { memberRow } from './user-views';

/** `platform.session.revoke_reason` of the sessions ended by the removal of their sign-in link (varchar(40)). */
export const IDENTITY_UNLINKED_REASON = 'identity_unlinked';

export interface IdentityRemoval {
  provider: string;
  reason: string;
}

/** What one removal did. */
export interface RemovedIdentity {
  provider: { id: string; slug: string; displayName: string };
  subjects: string[];
  sessions: number;
}

function orgOf(principal: Principal): NonNullable<Principal['org']> {
  if (!principal.org) throw new NotFoundError('No current organisation');
  return principal.org;
}

@Injectable()
export class IdentitiesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `POST /admin/users/{id}/identities/remove`: 404 for a non-member, an unknown provider or no link through it. */
  async remove(principal: Principal, userId: string, body: IdentityRemoval): Promise<CommandResult> {
    const removed = await this.scope.withTenant(tenantContextOf(principal), (trx) => this.removeIn(trx, principal, userId, body));
    const name = removed.provider.displayName;
    return {
      ok: true,
      changed: [],
      count: removed.sessions,
      message: removed.sessions > 0
        ? [`Linked sign-in through ${name} removed; ${removed.sessions} session(s) signed in through it ended`, `Masuk tertaut melalui ${name} dihapus; ${removed.sessions} sesi yang masuk melaluinya diakhiri`]
        : [`Linked sign-in through ${name} removed`, `Masuk tertaut melalui ${name} dihapus`],
      data: { provider: removed.provider.slug, subjects: removed.subjects.length, sessionsEnded: removed.sessions },
    };
  }

  /** The removal inside the caller's tenant transaction. */
  async removeIn(trx: Trx, principal: Principal, userId: string, body: IdentityRemoval): Promise<RemovedIdentity> {
    const org = orgOf(principal);
    const member = await memberRow(trx, org.id, userId);
    if (!member || member.kind === 'system') throw new NotFoundError('Not a member of this organisation');
    const provider = await trx
      .selectFrom('platform.identity_provider')
      .select(['id', 'slug', 'display_name'])
      .where('organization_id', '=', org.id)
      .where('slug', '=', body.provider)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!provider) throw new NotFoundError('Unknown identity provider of this organisation');
    const rows = await trx
      .deleteFrom('platform.user_identity')
      .where('identity_provider_id', '=', provider.id)
      .where('user_id', '=', userId)
      .returning('subject')
      .execute();
    if (rows.length === 0) throw new NotFoundError(`The member has no linked sign-in through ${provider.slug}`);
    const now = this.clock.now();
    // F.1: the sessions signed in through the removed link end with it (platform.session shows every row only in
    // platform scope, switched on for this statement inside the tenant transaction).
    const ended = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.session')
        .set({ revoked_at: now, revoke_reason: IDENTITY_UNLINKED_REASON })
        .where('user_id', '=', userId)
        .where('identity_provider_id', '=', provider.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    const sessions = Number(ended.numUpdatedRows);
    const account = await trx.selectFrom('platform.app_user').select('handle').where('id', '=', userId).executeTakeFirstOrThrow();
    const subjects = rows.map((r) => r.subject).sort();
    await this.audit.record(trx, {
      action: 'identity.unlinked',
      organizationId: org.id,
      entityType: 'user',
      entityId: userId,
      entityCode: account.handle,
      after: { provider: provider.slug, subjects, unlinked: true, reason: body.reason, sessionsRevoked: sessions, at: now.toISOString() },
    });
    return { provider: { id: provider.id, slug: provider.slug, displayName: provider.display_name }, subjects, sessions };
  }

  /** True when the member still has a linked sign-in through the provider of this organisation with id `providerId`. */
  async isLinked(trx: Trx, userId: string, providerId: string): Promise<boolean> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from platform.user_identity where user_id = ${userId} and identity_provider_id = ${providerId}`.execute(trx);
    return (rows[0]?.n ?? 0) > 0;
  }
}
