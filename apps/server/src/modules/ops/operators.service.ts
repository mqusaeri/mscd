// The platform operators of the service (Milestone 2 section L, M2-19), in both tenancy modes:
// - `GET /ops/operators`: every account with an active `platform_operator` role, whether its second factor is set up,
//   whether its set-password link is still unused, its last sign-in and who granted the role.
// - `POST /ops/operators`: the flow of `admin create-operator` (src/cli/admin.ts) for a signed-in operator. A new
//   account (active, no password, TOTP required at the first sign-in) or an existing one gets the role; an account
//   without a password gets a one-time link to set it (token kind `set_password`, 72 hours; older unused links stop
//   working), emailed with the template `operator_invitation`; an account with a password gets `operator_granted`.
//   Refused for the system account, a disabled account and an operator that already has a password; with
//   `mail.required` nothing is written while mail does not work. Audited `ops.operator_created` with the reason.
// - `DELETE /ops/operators/{id}`: ends the role and every session of the account (reason `roles_changed`), as
//   `admin revoke-operator` does; its memberships stay. Never the operator's own account (403 `own_account`), never the
//   last active operator (409 `last_operator`). Audited `ops.operator_revoked` with the reason.
// The application role only reads `platform.platform_role`, so the two writes run as the database owner
// (`withOwner`, 503 without `database.migrator_url_file`), in one transaction with the audit entry. A removal locks
// the active operator accounts first (`lockActiveOperators`, the order a disable takes too), so two operators who
// remove or disable each other at the same time wait for each other, and the second gets 409 `last_operator`.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OpsOperatorAdd, OpsOperatorAddResult, OpsOperatorItem, OpsOperatorRemoveResult } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, type AuditWriter, type Principal as RequestPrincipal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { AccountMailer } from '../identity/account-mailer';
import { INVITATION_TTL_MS, handleBase } from '../identity/invitation.service';
import { SessionService } from '../identity/session.service';
import { randomToken, sha256 } from '../identity/tokens';
import { TenantScope } from '../tenancy/tenant-scope';
import { conflict, lastOperator, lockActiveOperators, mailRequired, notFound, ownAccount, systemAccount, unknownAccount, withOwner } from './account-support';
import { checkMailReadiness } from './mail-readiness';

/** Validity of the set-password link of a new platform operator (the 72 hours of `admin create-operator`). */
export const OPERATOR_LINK_TTL_MS = INVITATION_TTL_MS;
const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;

interface ExistingAccount {
  id: string;
  handle: string;
  email: string;
  status: 'active' | 'invited' | 'disabled';
  kind: 'person' | 'system' | 'guest';
  password_hash: string | null;
}

@Injectable()
export class OperatorsService {
  private readonly logger = new Logger('OpsOperators');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly sessions: SessionService,
    private readonly mailer: AccountMailer,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `GET /ops/operators`. */
  async list(principal: RequestPrincipal): Promise<OpsOperatorItem[]> {
    const rows = await this.scope.withPlatform(
      async (trx) => {
        await sql`set transaction read only`.execute(trx);
        const { rows: found } = await sql<{
          id: string; handle: string; email: string; display_name: string; status: OpsOperatorItem['status']; password_set: boolean; mfa_enrolled: boolean;
          last_login_at: Date | null; granted_at: Date; granted_by_handle: string | null; granted_by_name: string | null;
        }>`
          select u.id, u.handle, u.email, u.display_name, u.status, (u.password_hash is not null) as password_set,
                 exists (select 1 from platform.mfa_factor f where f.user_id = u.id and f.confirmed_at is not null and f.deleted_at is null) as mfa_enrolled,
                 u.last_login_at, r.granted_at, g.handle as granted_by_handle, g.display_name as granted_by_name
            from platform.platform_role r
            join platform.app_user u on u.id = r.user_id
            left join platform.app_user g on g.id = r.granted_by
           where r.role = 'platform_operator' and r.revoked_at is null and u.deleted_at is null
           order by lower(u.display_name), lower(u.email), u.id`.execute(trx);
        return found;
      },
      { scope: 'operator', userId: principal.user.id, requestId: currentRequestId() },
    );
    return rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
      mfaEnrolled: r.mfa_enrolled,
      passwordSet: r.password_set,
      lastSignInAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
      grantedAt: new Date(r.granted_at).toISOString(),
      grantedBy: r.granted_by_handle !== null && r.granted_by_name !== null ? { handle: r.granted_by_handle, displayName: r.granted_by_name } : null,
      self: r.id === principal.user.id,
    }));
  }

  /** The account of an email address (guests are per grant and never become operators), with the refusals of `add`. */
  private async existing(trx: Trx, email: string, lock: boolean): Promise<ExistingAccount | undefined> {
    let query = trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'status', 'kind', 'password_hash'])
      .where(sql<string>`lower(email)`, '=', email.toLowerCase())
      .where('kind', '<>', 'guest')
      .where('deleted_at', 'is', null);
    if (lock) query = query.forUpdate();
    const found = await query.executeTakeFirst();
    if (found?.kind === 'system') throw systemAccount();
    if (found?.status === 'disabled') {
      throw conflict('account_disabled', 'The account of this email address is disabled. Enable it first.', 'Akun dengan alamat email ini dinonaktifkan. Aktifkan terlebih dahulu.');
    }
    return found;
  }

  /** 409 `already_operator` for an account that holds the role and has set its password. */
  private alreadyOperator(email: string): never {
    throw conflict('already_operator', `${email} is a platform operator already.`, `${email} sudah menjadi operator platform.`);
  }

  /** `POST /ops/operators`. */
  async add(principal: RequestPrincipal, body: OpsOperatorAdd): Promise<OpsOperatorAddResult> {
    const email = body.email.trim();
    const name = body.name.trim();
    const reason = body.reason.trim();
    // The refusals that need no mail come first, so a wrong request is answered without the SMTP check.
    await this.scope.withPlatform(
      async (trx) => {
        await sql`set transaction read only`.execute(trx);
        const found = await this.existing(trx, email, false);
        if (found && found.password_hash !== null) {
          const role = await trx
            .selectFrom('platform.platform_role')
            .select('revoked_at')
            .where('user_id', '=', found.id)
            .where('role', '=', 'platform_operator')
            .executeTakeFirst();
          if (role && role.revoked_at === null) this.alreadyOperator(found.email);
        }
      },
      { scope: 'operator', userId: principal.user.id, requestId: currentRequestId() },
    );
    const mail = await checkMailReadiness(this.config);
    if (!mail.ok && this.config.profile.mail.required) throw mailRequired(mail.reason);

    const done = await withOwner(this.config, 'Adding a platform operator', async (trx) => {
      const now = this.clock.now();
      const found = await this.existing(trx, email, true);
      let user: { id: string; handle: string; email: string; passwordSet: boolean };
      if (found) {
        // An invited account that never signed in becomes active: the set-password link replaces its invitation.
        await trx.updateTable('platform.app_user').set({ mfa_required: true, status: 'active', updated_by: principal.user.id }).where('id', '=', found.id).execute();
        user = { id: found.id, handle: found.handle, email: found.email, passwordSet: found.password_hash !== null };
      } else {
        const handle = await uniqueHandle(trx, email);
        const created = await trx
          .insertInto('platform.app_user')
          .values({
            handle, email, display_name: name, kind: 'person', status: 'active', mfa_required: true, created_by: principal.user.id, updated_by: principal.user.id,
          })
          .returning(['id', 'handle', 'email'])
          .executeTakeFirstOrThrow();
        user = { ...created, passwordSet: false };
      }
      const role = await trx
        .selectFrom('platform.platform_role')
        .select(['revoked_at'])
        .where('user_id', '=', user.id)
        .where('role', '=', 'platform_operator')
        .forUpdate()
        .executeTakeFirst();
      const alreadyOperator = role !== undefined && role.revoked_at === null;
      if (alreadyOperator && user.passwordSet) this.alreadyOperator(user.email);
      if (!role) {
        await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator', granted_at: now, granted_by: principal.user.id }).execute();
      } else if (!alreadyOperator) {
        await trx
          .updateTable('platform.platform_role')
          .set({ revoked_at: null, granted_at: now, granted_by: principal.user.id })
          .where('user_id', '=', user.id)
          .where('role', '=', 'platform_operator')
          .execute();
      }
      let token: string | null = null;
      let expiresAt: Date | null = null;
      if (!user.passwordSet) {
        // One usable link at a time: older unused set-password links stop working.
        await trx
          .updateTable('platform.password_reset_token')
          .set({ used_at: now })
          .where('user_id', '=', user.id)
          .where('kind', '=', 'set_password')
          .where('used_at', 'is', null)
          .execute();
        token = randomToken();
        expiresAt = new Date(now.getTime() + OPERATOR_LINK_TTL_MS);
        await trx
          .insertInto('platform.password_reset_token')
          .values({ token_hash: sha256(token), kind: 'set_password', user_id: user.id, created_at: now, expires_at: expiresAt })
          .execute();
      }
      await this.audit.record(trx, {
        action: 'ops.operator_created',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: null,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.handle,
        requestId: currentRequestId() ?? null,
        after: {
          email: user.email,
          newAccount: !found,
          roleGranted: !alreadyOperator,
          setPasswordLink: token !== null,
          ...(expiresAt ? { linkExpiresAt: expiresAt.toISOString() } : {}),
          mfaRequired: true,
          reason,
          by: 'platform_operator',
        },
      });
      return { user, newAccount: !found, token, expiresAt };
    });

    const link = done.token ? this.mailer.appLink(`/reset-password#token=${done.token}`) : null;
    const emailed = mail.ok
      ? await this.mailer.send({
          to: { email: done.user.email, userId: done.user.id },
          template: link ? { name: 'operator_invitation', link, hours: OPERATOR_LINK_TTL_MS / 3_600_000 } : { name: 'operator_granted', link: this.mailer.appLink('/login') },
        })
      : false;
    if (!emailed) this.logger.warn({ userId: done.user.id }, 'The email of a new platform operator was not sent');
    const shown = link !== null && !emailed && !this.config.profile.mail.required;
    const address = done.user.email;
    const message: [string, string] = emailed
      ? link
        ? [`${address} is now a platform operator. A link to set the password was emailed; it works once, for 72 hours.`, `${address} sekarang operator platform. Tautan untuk mengatur kata sandi telah dikirim; berlaku sekali, selama 72 jam.`]
        : [`${address} is now a platform operator and was told by email.`, `${address} sekarang operator platform dan telah diberi tahu melalui email.`]
      : shown
        ? [`${address} is now a platform operator. Mail is not working, so give the one-time link to set the password to the operator yourself.`, `${address} sekarang operator platform. Email tidak berfungsi, jadi berikan sendiri tautan sekali pakai untuk mengatur kata sandi kepada operator.`]
        : [`${address} is now a platform operator, but the email could not be sent.`, `${address} sekarang operator platform, tetapi email tidak dapat dikirim.`];
    return {
      ok: true,
      changed: [],
      message,
      data: {
        id: done.user.id,
        handle: done.user.handle,
        email: done.user.email,
        newAccount: done.newAccount,
        emailed,
        ...(shown && link && done.expiresAt ? { link, expiresAt: done.expiresAt.toISOString() } : {}),
      },
    };
  }

  /** `DELETE /ops/operators/{id}`. */
  async remove(principal: RequestPrincipal, id: string, reason: string): Promise<OpsOperatorRemoveResult> {
    if (id === principal.user.id) throw ownAccount();
    return withOwner(this.config, 'Removing a platform operator', async (trx) => {
      const now = this.clock.now();
      // Every active operator account, locked before the target: the last-operator check and the change are one
      // decision, and a disable takes its locks in the same order.
      const ids = await lockActiveOperators(trx);
      const user = await trx
        .selectFrom('platform.app_user')
        .select(['id', 'handle', 'email', 'kind'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw unknownAccount();
      if (user.kind === 'system') throw systemAccount();
      if (ids.includes(user.id) && ids.length === 1) throw lastOperator();
      const revoked = await trx
        .updateTable('platform.platform_role')
        .set({ revoked_at: now })
        .where('user_id', '=', user.id)
        .where('role', '=', 'platform_operator')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(revoked.numUpdatedRows) === 0) throw notFound('not_operator', 'The account is not a platform operator.', 'Akun ini bukan operator platform.');
      const sessions = await this.sessions.revokeUserSessions(trx, user.id, 'roles_changed');
      const left = ids.filter((x) => x !== user.id).length;
      await this.audit.record(trx, {
        action: 'ops.operator_revoked',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: null,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.handle,
        requestId: currentRequestId() ?? null,
        after: { email: user.email, sessionsRevoked: sessions, operatorsLeft: left, reason: reason.trim(), by: 'platform_operator' },
      });
      return {
        ok: true as const,
        changed: [],
        message: [
          `${user.email} is no longer a platform operator. ${sessions} session(s) were ended.`,
          `${user.email} bukan lagi operator platform. ${sessions} sesi diakhiri.`,
        ] as [string, string],
        data: { id: user.id, sessionsRevoked: sessions, operatorsLeft: left },
      };
    });
  }
}

/** A free handle from the email's local part, as `InvitationService` and `admin create-operator` choose one. */
async function uniqueHandle(trx: Trx, email: string): Promise<string> {
  const base = handleBase(email);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!HANDLE.test(candidate)) continue;
    const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', candidate).executeTakeFirst();
    if (!taken) return candidate;
  }
  throw conflict('no_free_handle', 'No free user handle is left for this email address.', 'Tidak ada handle pengguna yang tersedia untuk alamat email ini.');
}
