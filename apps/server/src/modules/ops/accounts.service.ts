// The accounts of the service for the platform operator (Milestone 2 section L, M2-19), in both tenancy modes:
// - `GET /ops/accounts`: every account that is not deleted (people, guests and the system account), with search by
//   name, email or handle and filters by organisation, account status and kind, paged. Each row says whether a
//   second factor is set up and whether the account is locked now, its last sign-in, whether it is a platform
//   operator, and its memberships with the organisation, the membership status and the admin roles. The password
//   hash, factor secrets and the business roles inside a customer organisation never leave the database: the
//   operator supports accounts, and the customer's Tenant Admin keeps the roles (ISO/IEC 27001 A.5.18).
// - `GET /ops/accounts/{id}`: the row, the open sessions (start, last activity, method, network cut to /24 or /48,
//   browser and system read from the user agent) and the latest 20 platform audit entries about the account.
// - The actions, each with a reason of 3 to 500 characters and one platform audit entry (actor kind `operator`):
//   `reset-mfa` (`auth.mfa_reset`, OperatorAccountsService; the security email goes out after the commit and the
//   answer says whether it did), `password-reset` (a one-time link by email,
//   `auth.password_reset` with step `link_sent`), `invitations/{org}/resend` (a new invitation link, the older ones
//   revoked, `user.invited` with `resent`), `sessions/revoke` (`auth.session_revoked`) and `status` (`user.updated`;
//   disabled ends every session; an invited account is neither disabled nor enabled; `If-Match` with the row's ETag).
// Refusals: the operator's own account (403 `own_account`: reset the second factor, which ends every session, end
// sessions, disable), the system account (409 `system_account`), the last active operator (409 `last_operator`), and
// with `mail.required` the actions that send a link while mail does not work (409 `mail_required`, before anything is
// written). The 404 answers carry a message key too (`unknown_account`, `unknown_organisation`, `membership_not_found`). Where mail is not required and the
// email did not go out, the answer carries the link once (never on SaaS), as the organisation creation does.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AccountStatus, OpsAccountActionResult, OpsAccountAuditEntry, OpsAccountDetail, OpsAccountItem, OpsAccountListQuery, OpsAccountMembership,
  OpsAccountSession, OpsAccountStatusChange, Page,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch, etagOf } from '../../common/etag';
import { currentRequestId } from '../../common/request-context';
import { AUDIT_WRITER, LICENCE_GATE, type AuditWriter, type LicenceGate, type Principal, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { AccountMailer } from '../identity/account-mailer';
import { RESET_TOKEN_TTL_MS } from '../identity/auth.service';
import { INVITATION_TTL_MS, InvitationService } from '../identity/invitation.service';
import { decideLocalLogin } from '../identity/local-login-policy';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { randomToken, sha256 } from '../identity/tokens';
import { TenantScope } from '../tenancy/tenant-scope';
import {
  browserOf, conflict, lastOperator, lockActiveOperators, mailRequired, notFound, ownAccount, revokeAllSessions, systemAccount, unknownAccount,
} from './account-support';
import { checkMailReadiness, type MailReadiness } from './mail-readiness';
import { OperatorAccountsService } from './operator-accounts.service';

/** Platform audit entries the account detail lists. */
export const ACCOUNT_AUDIT_ENTRIES = 20;
/** Open sessions the account detail lists, the latest active first. */
export const ACCOUNT_SESSIONS = 50;

interface AccountRow {
  id: string;
  handle: string;
  email: string;
  display_name: string;
  kind: OpsAccountItem['kind'];
  status: AccountStatus;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  locked: boolean;
  mfa_enrolled: boolean;
  platform_operator: boolean;
}

/** The account a write acts on, locked for the transaction. */
interface Target {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  kind: OpsAccountItem['kind'];
  status: AccountStatus;
  updatedAt: Date;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

@Injectable()
export class OpsAccountsService {
  private readonly logger = new Logger('OpsAccounts');

  constructor(
    private readonly config: MscdConfig,
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly invitations: InvitationService,
    private readonly mailer: AccountMailer,
    private readonly factors: OperatorAccountsService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LICENCE_GATE) private readonly licence: LicenceGate,
  ) {}

  /** The platform-scope transaction of an operator request. */
  private platform<T>(principal: Principal | null, fn: (trx: Trx) => Promise<T>, orgId?: string | null): Promise<T> {
    return this.scope.withPlatform(fn, { scope: 'operator', userId: principal?.user.id ?? null, orgId: orgId ?? null, requestId: currentRequestId() });
  }

  /** `GET /ops/accounts`. */
  async list(query: OpsAccountListQuery): Promise<Page<OpsAccountItem>> {
    const now = this.clock.now();
    const search = query.q ? `%${query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = sql`u.deleted_at is null
      ${search ? sql`and (lower(u.display_name) like ${search} or lower(u.email) like ${search} or lower(u.handle) like ${search})` : sql``}
      ${query.status ? sql`and u.status = ${query.status}` : sql``}
      ${query.kind ? sql`and u.kind = ${query.kind}` : sql``}
      ${query.org
        ? sql`and exists (select 1 from platform.org_membership m join platform.organization o on o.id = m.organization_id
                           where m.user_id = u.id and m.deleted_at is null and o.deleted_at is null and o.slug = ${query.org})`
        : sql``}`;
    const { total, rows, memberships } = await this.platform(null, async (trx) => {
      await sql`set transaction read only`.execute(trx);
      const counted = await sql<{ n: string }>`select count(*) as n from platform.app_user u where ${where}`.execute(trx);
      const listed = await sql<AccountRow>`
        select ${accountColumns(now)}
          from platform.app_user u
         where ${where}
         order by lower(u.display_name), lower(u.email), u.id
         limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(trx);
      return { total: Number(counted.rows[0]?.n ?? 0), rows: listed.rows, memberships: await membershipsOf(trx, listed.rows.map((r) => r.id)) };
    });
    return { items: rows.map((r) => itemOf(r, memberships.get(r.id) ?? [])), page: query.page, pageSize: query.pageSize, total };
  }

  /** `GET /ops/accounts/{id}`: 404 for an unknown or deleted account. */
  async detail(id: string): Promise<OpsAccountDetail> {
    const now = this.clock.now();
    const found = await this.platform(null, async (trx) => {
      await sql`set transaction read only`.execute(trx);
      const { rows } = await sql<AccountRow>`select ${accountColumns(now)} from platform.app_user u where u.id = ${id} and u.deleted_at is null`.execute(trx);
      const row = rows[0];
      if (!row) return null;
      const sessions = await sql<{
        created_at: Date; last_seen_at: Date; auth_method: OpsAccountSession['method']; state: OpsAccountSession['state']; network: string | null;
        user_agent: string | null; org: string | null;
      }>`
        select s.created_at, s.last_seen_at, s.auth_method, s.state,
               case when s.ip is null then null
                    else network(set_masklen(s.ip, case family(s.ip) when 4 then 24 else 48 end))::text end as network,
               s.user_agent, o.slug as org
          from platform.session s
          left join platform.organization o on o.id = s.organization_id
         where s.user_id = ${id} and s.revoked_at is null and s.idle_expires_at > ${now} and s.absolute_expires_at > ${now}
         order by s.last_seen_at desc
         limit ${ACCOUNT_SESSIONS}`.execute(trx);
      const audit = await sql<{
        occurred_at: Date; action: string; actor_kind: OpsAccountAuditEntry['actorKind']; reason: string | null; handle: string | null;
        display_name: string | null; org: string | null;
      }>`
        select a.occurred_at, a.action, a.actor_kind,
               case when a.actor_kind = 'operator' then a.after_data->>'reason' end as reason,
               u.handle, u.display_name, o.slug as org
          from platform.audit_log a
          left join platform.app_user u on u.id = a.actor_user_id
          left join platform.organization o on o.id = a.organization_id
         where (a.entity_type in ('user', 'org_membership') and a.entity_id = ${id})
            or (a.entity_type = 'invitation' and a.entity_id in (select i.id from platform.invitation i where i.user_id = ${id}))
         order by a.seq desc
         limit ${ACCOUNT_AUDIT_ENTRIES}`.execute(trx);
      return { row, sessions: sessions.rows, audit: audit.rows, memberships: await membershipsOf(trx, [id]) };
    });
    if (!found) throw unknownAccount();
    return {
      ...itemOf(found.row, found.memberships.get(id) ?? []),
      sessions: found.sessions.map((s) => ({
        startedAt: iso(s.created_at),
        lastSeenAt: iso(s.last_seen_at),
        method: s.auth_method,
        state: s.state,
        network: s.network,
        browser: browserOf(s.user_agent),
        org: s.org,
      })),
      audit: found.audit.map((a) => ({
        at: iso(a.occurred_at),
        action: a.action,
        actorKind: a.actor_kind,
        actor: a.handle !== null && a.display_name !== null ? { handle: a.handle, displayName: a.display_name } : null,
        org: a.org,
        reason: typeof a.reason === 'string' ? a.reason : null,
      })),
    };
  }

  /** The account of a write, locked; 404 when unknown, 409 for the system account. */
  private async lockTarget(trx: Trx, id: string): Promise<Target> {
    const row = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'display_name', 'kind', 'status', 'updated_at'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw unknownAccount();
    if (row.kind === 'system') throw systemAccount();
    return { id: row.id, handle: row.handle, email: row.email, displayName: row.display_name, kind: row.kind, status: row.status, updatedAt: row.updated_at };
  }

  /** The mail rule of the actions that send a link: with `mail.required`, refuse while SMTP does not work. */
  private async mailFor(): Promise<MailReadiness> {
    const mail = await checkMailReadiness(this.config);
    if (!mail.ok && this.config.profile.mail.required) throw mailRequired(mail.reason);
    return mail;
  }

  /**
   * `POST /ops/accounts/{id}/reset-mfa`: 409 `no_second_factor` when the account has none. Never the operator's own
   * account (403 `own_account`): the reset ends every session, and the person replaces their own authenticator on My
   * account. The reset does not wait for mail (the email only tells the person about it); the security email is sent
   * after the commit, and `emailed` says whether it went out.
   */
  async resetMfa(principal: Principal, id: string, reason: string): Promise<OpsAccountActionResult> {
    if (id === principal.user.id) throw ownAccount();
    const outcome = await this.platform(principal, async (trx) => {
      const target = await this.lockTarget(trx, id);
      if (!(await this.mfa.hasConfirmedFactor(trx, target.id))) {
        throw conflict('no_second_factor', 'This account has no second factor set up, so there is nothing to reset.', 'Akun ini belum mengatur faktor kedua, jadi tidak ada yang perlu diatur ulang.');
      }
      const revoked = await this.factors.resetFactorOf(trx, principal.user.id, target, reason.trim(), 'caller');
      return { target, revoked };
    });
    const { target, revoked } = outcome;
    const emailed = await this.mailer.send(this.factors.resetMail(target));
    if (!emailed) this.logger.warn({ userId: target.id }, 'The email about an operator reset of the second factor was not sent');
    return result(target.id, target.status, revoked, emailed, emailed
      ? [
          `The second factor of ${target.email} was reset. ${revoked} session(s) were ended and the account was told by email.`,
          `Faktor kedua ${target.email} telah diatur ulang. ${revoked} sesi diakhiri dan akun diberi tahu melalui email.`,
        ]
      : [
          `The second factor of ${target.email} was reset. ${revoked} session(s) were ended. The email to tell the account could not be sent, so tell the person yourself.`,
          `Faktor kedua ${target.email} telah diatur ulang. ${revoked} sesi diakhiri. Email pemberitahuan ke akun tidak dapat dikirim, jadi beri tahu sendiri orang tersebut.`,
        ]);
  }

  /** The checks of the password reset on a locked or read account. */
  private async assertPasswordResettable(trx: Trx, target: Target): Promise<void> {
    if (target.kind === 'guest') {
      throw conflict('guest_account', 'A guest account signs in with one-time codes and has no password.', 'Akun tamu masuk dengan kode sekali pakai dan tidak memiliki kata sandi.');
    }
    if (target.status !== 'active') {
      throw target.status === 'invited'
        ? conflict('account_not_active', 'This account has not accepted its invitation yet. Send the invitation again instead.', 'Akun ini belum menerima undangannya. Kirim ulang undangan sebagai gantinya.')
        : conflict('account_not_active', 'This account is disabled. Enable it before you send a password link.', 'Akun ini dinonaktifkan. Aktifkan terlebih dahulu sebelum mengirim tautan kata sandi.');
    }
    const decision = await decideLocalLogin(trx, target.id);
    if (!decision.allowed && decision.memberOrgIds.length === 0) {
      throw conflict(
        'no_membership',
        'This account belongs to no active organisation, so it cannot sign in with a password. Invite it to an organisation instead.',
        'Akun ini tidak tergabung dalam organisasi aktif mana pun, jadi tidak dapat masuk dengan kata sandi. Undang akun ini ke sebuah organisasi.',
      );
    }
    if (!decision.allowed) {
      throw conflict(
        'local_login_not_allowed',
        'The organisations of this account allow sign-in only through their identity provider, so a password would not work.',
        'Organisasi akun ini hanya mengizinkan masuk melalui penyedia identitasnya, jadi kata sandi tidak akan berfungsi.',
      );
    }
  }

  /**
   * `POST /ops/accounts/{id}/password-reset`: a one-time link to set a new password (token kind `reset`, the 30
   * minutes of F.4), emailed with the template of the self-service reset; older unused links of the account stop
   * working. The password and the sessions change only when the person uses the link (`POST /auth/password/reset`).
   */
  async passwordReset(principal: Principal, id: string, reason: string): Promise<OpsAccountActionResult> {
    await this.platform(principal, async (trx) => {
      await sql`set transaction read only`.execute(trx);
      const target = await this.readTarget(trx, id);
      await this.assertPasswordResettable(trx, target);
    });
    const mail = await this.mailFor();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);
    const token = randomToken();
    const target = await this.platform(principal, async (trx) => {
      const locked = await this.lockTarget(trx, id);
      await this.assertPasswordResettable(trx, locked);
      const older = await trx
        .updateTable('platform.password_reset_token')
        .set({ used_at: now })
        .where('user_id', '=', locked.id)
        .where('kind', '=', 'reset')
        .where('used_at', 'is', null)
        .executeTakeFirst();
      await trx
        .insertInto('platform.password_reset_token')
        .values({ token_hash: sha256(token), kind: 'reset', user_id: locked.id, created_at: now, expires_at: expiresAt })
        .execute();
      await this.audit.record(trx, {
        action: 'auth.password_reset',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: null,
        entityType: 'user',
        entityId: locked.id,
        entityCode: locked.handle,
        after: { step: 'link_sent', by: 'platform_operator', reason: reason.trim(), olderLinksEnded: Number(older.numUpdatedRows), expiresAt: expiresAt.toISOString(), mailReady: mail.ok },
      });
      return locked;
    });
    const link = this.mailer.appLink(`/reset-password#token=${token}`);
    const emailed = mail.ok
      ? await this.mailer.send({ to: { email: target.email, userId: target.id }, template: { name: 'password_reset', link, minutes: RESET_TOKEN_TTL_MS / 60_000 } })
      : false;
    if (!emailed) this.logger.warn({ userId: target.id }, 'The password link of an operator reset was not emailed');
    const shown = !emailed && !this.config.profile.mail.required;
    return result(
      target.id,
      target.status,
      0,
      emailed,
      emailed
        ? [`A link to set a new password was emailed to ${target.email}. It works once, for 30 minutes.`, `Tautan untuk mengatur kata sandi baru telah dikirim ke ${target.email}. Tautan berlaku sekali, selama 30 menit.`]
        : shown
          ? ['Mail is not working, so no email went out. Give the one-time link to the person yourself.', 'Email tidak berfungsi, jadi tidak ada email yang terkirim. Berikan sendiri tautan sekali pakai kepada orang tersebut.']
          : [`The email to ${target.email} could not be sent. Try again when mail works.`, `Email ke ${target.email} tidak dapat dikirim. Coba lagi saat email berfungsi.`],
      shown ? { link, expiresAt: expiresAt.toISOString() } : {},
    );
  }

  /** The account of a check outside a write: 404 when unknown, 409 for the system account (not locked). */
  private async readTarget(trx: Trx, id: string): Promise<Target> {
    const row = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'display_name', 'kind', 'status', 'updated_at'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw unknownAccount();
    if (row.kind === 'system') throw systemAccount();
    return { id: row.id, handle: row.handle, email: row.email, displayName: row.display_name, kind: row.kind, status: row.status, updatedAt: row.updated_at };
  }

  /** The organisation and the membership of an invitation resend, with their checks (404, 409). */
  private async invitedMembership(trx: Trx, target: Target, slug: string): Promise<{ id: string; name: string }> {
    const org = await trx
      .selectFrom('platform.organization')
      .select(['id', 'name', 'status'])
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!org) throw notFound('unknown_organisation', `There is no organisation ${slug}.`, `Tidak ada organisasi ${slug}.`);
    const membership = await trx
      .selectFrom('platform.org_membership')
      .select(['status'])
      .where('organization_id', '=', org.id)
      .where('user_id', '=', target.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!membership) {
      throw notFound('membership_not_found', 'The account has no membership of this organisation.', 'Akun ini tidak memiliki keanggotaan di organisasi ini.');
    }
    if (membership.status !== 'invited') {
      throw conflict('membership_not_invited', 'This membership is not waiting for its invitation to be accepted.', 'Keanggotaan ini tidak sedang menunggu undangannya diterima.');
    }
    if (target.status === 'disabled') {
      throw conflict('account_disabled', 'This account is disabled. Enable it before you send the invitation again.', 'Akun ini dinonaktifkan. Aktifkan terlebih dahulu sebelum mengirim ulang undangan.');
    }
    if (org.status === 'archived' || org.status === 'deleted') {
      throw conflict('organization_archived', 'The organisation is archived, so nobody can join it.', 'Organisasi telah diarsipkan, jadi tidak ada yang dapat bergabung.');
    }
    return { id: org.id, name: org.name };
  }

  /**
   * `POST /ops/accounts/{id}/invitations/{org}/resend`: a new invitation link (72 hours) for an invited membership,
   * emailed with the invitation template; the unused links of the membership are revoked. An account that is already
   * active (invited to one more organisation) accepts the link with its current password, which it never replaces.
   */
  async resendInvitation(principal: Principal, id: string, slug: string, reason: string): Promise<OpsAccountActionResult> {
    await this.platform(principal, async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await this.invitedMembership(trx, await this.readTarget(trx, id), slug);
    });
    const mail = await this.mailFor();
    const now = this.clock.now();
    const done = await this.platform(principal, async (trx) => {
      const target = await this.lockTarget(trx, id);
      const org = await this.invitedMembership(trx, target, slug);
      const revoked = await trx
        .updateTable('platform.invitation')
        .set({ revoked_at: now })
        .where('organization_id', '=', org.id)
        .where('user_id', '=', target.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const invitation = await this.invitations.createInvitation(trx, { orgId: org.id, userId: target.id, email: target.email, createdBy: principal.user.id });
      await this.audit.record(trx, {
        action: 'user.invited',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: org.id,
        entityType: 'invitation',
        entityId: invitation.invitationId,
        entityCode: target.handle,
        after: {
          userId: target.id,
          resent: true,
          by: 'platform_operator',
          reason: reason.trim(),
          olderLinksRevoked: Number(revoked.numUpdatedRows),
          link: true,
          expiresAt: invitation.expiresAt.toISOString(),
          at: now.toISOString(),
        },
      });
      return { target, org, invitation };
    }, null);
    const { target, org, invitation } = done;
    const emailed = mail.ok
      ? await this.mailer.send({
          to: { email: target.email, userId: target.id },
          template: { name: 'invitation', link: invitation.link, organisation: org.name, hours: INVITATION_TTL_MS / 3_600_000 },
        })
      : false;
    if (!emailed) this.logger.warn({ userId: target.id, orgId: org.id }, 'The invitation sent again by the operator was not emailed');
    const shown = !emailed && !this.config.profile.mail.required;
    return result(
      target.id,
      target.status,
      0,
      emailed,
      emailed
        ? [`A new invitation to ${org.name} was emailed to ${target.email}. The older links no longer work.`, `Undangan baru ke ${org.name} telah dikirim ke ${target.email}. Tautan lama tidak berlaku lagi.`]
        : shown
          ? ['Mail is not working, so no email went out. Give the one-time invitation link to the person yourself.', 'Email tidak berfungsi, jadi tidak ada email yang terkirim. Berikan sendiri tautan undangan sekali pakai kepada orang tersebut.']
          : [`The email to ${target.email} could not be sent. Try again when mail works.`, `Email ke ${target.email} tidak dapat dikirim. Coba lagi saat email berfungsi.`],
      shown ? { link: invitation.link, expiresAt: invitation.expiresAt.toISOString() } : {},
    );
  }

  /** `POST /ops/accounts/{id}/sessions/revoke`: never the operator's own sessions (403 `own_account`). */
  async revokeSessions(principal: Principal, id: string, reason: string): Promise<OpsAccountActionResult> {
    if (id === principal.user.id) throw ownAccount();
    const outcome = await this.platform(principal, async (trx) => {
      const target = await this.lockTarget(trx, id);
      const revoked = await revokeAllSessions(trx, target.id, this.clock.now());
      await this.audit.record(trx, {
        action: 'auth.session_revoked',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: null,
        entityType: 'user',
        entityId: target.id,
        entityCode: target.handle,
        after: { by: 'platform_operator', reason: reason.trim(), sessionsRevoked: revoked, scope: 'all_sessions' },
      });
      return { target, revoked };
    });
    return result(outcome.target.id, outcome.target.status, outcome.revoked, false, [
      `${outcome.revoked} session(s) of ${outcome.target.email} were ended. The person signs in again.`,
      `${outcome.revoked} sesi ${outcome.target.email} diakhiri. Orang tersebut masuk kembali.`,
    ]);
  }

  /**
   * `POST /ops/accounts/{id}/status`: `disabled` ends every session of the account; `active` enables a disabled
   * account again after the user limit of each organisation where it is an active member (LIC-USERS, D-15). Refused
   * for the operator's own account (403), an invited account either way (409 `account_invited`: it becomes active
   * when the person accepts the invitation, and can be disabled after that, as a Tenant Admin disables an invited
   * membership only after it is accepted; so an enabled account is always one that was active), the same status, and
   * the last active platform operator. `If-Match` with the ETag of the row (412 when stale).
   */
  async changeStatus(principal: Principal, id: string, body: OpsAccountStatusChange, ifMatch: string | undefined): Promise<OpsAccountActionResult> {
    if (id === principal.user.id) throw ownAccount();
    const reason = body.reason.trim();
    const outcome = await this.platform(principal, async (trx) => {
      // A disable decides about the last active operator. It locks the active operator accounts first, in id order,
      // and the target after them: the order of `OperatorsService.remove`, so two such decisions (two operators who
      // disable each other, or a disable next to a removal) wait for each other instead of deadlocking.
      const operators = body.status === 'disabled' ? await lockActiveOperators(trx) : [];
      const target = await this.lockTarget(trx, id);
      assertIfMatch(ifMatch, target.updatedAt, target.handle);
      if (target.status === body.status) {
        throw conflict('status_unchanged', `The account is ${body.status} already.`, body.status === 'active' ? 'Akun ini sudah aktif.' : 'Akun ini sudah dinonaktifkan.');
      }
      if (target.status === 'invited') {
        throw body.status === 'active'
          ? conflict('account_invited', 'An invited account becomes active when the person accepts the invitation.', 'Akun yang diundang menjadi aktif saat orang tersebut menerima undangan.')
          : conflict(
              'account_invited',
              'An invited account becomes active when the person accepts the invitation. It can be disabled after that.',
              'Akun yang diundang menjadi aktif saat orang tersebut menerima undangan. Setelah itu akun dapat dinonaktifkan.',
            );
      }
      if (body.status === 'disabled') {
        if (operators.includes(target.id) && operators.length === 1) throw lastOperator();
      } else if (target.kind === 'person') {
        const orgs = await trx
          .selectFrom('platform.org_membership as m')
          .innerJoin('platform.organization as o', 'o.id', 'm.organization_id')
          .select('m.organization_id')
          .where('m.user_id', '=', target.id)
          .where('m.status', '=', 'active')
          .where('m.deleted_at', 'is', null)
          .where('o.deleted_at', 'is', null)
          .execute();
        for (const org of orgs) await this.licence.assertCanAddUser(trx, org.organization_id);
      }
      await trx.updateTable('platform.app_user').set({ status: body.status, updated_by: principal.user.id }).where('id', '=', target.id).execute();
      const revoked = body.status === 'disabled' ? await this.sessions.revokeUserSessions(trx, target.id, 'user_disabled') : 0;
      await this.audit.record(trx, {
        action: 'user.updated',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: null,
        entityType: 'user',
        entityId: target.id,
        entityCode: target.handle,
        before: { accountStatus: target.status },
        after: { accountStatus: body.status, by: 'platform_operator', reason, sessionsRevoked: revoked },
      });
      return { target, revoked };
    });
    const { target, revoked } = outcome;
    return result(target.id, body.status, revoked, false, body.status === 'disabled'
      ? [`${target.email} was disabled. ${revoked} session(s) were ended.`, `${target.email} dinonaktifkan. ${revoked} sesi diakhiri.`]
      : [`${target.email} can sign in again.`, `${target.email} dapat masuk kembali.`]);
  }
}

/** The columns of an account row (`now` decides whether a lock is still in force). */
function accountColumns(now: Date) {
  return sql`u.id, u.handle, u.email, u.display_name, u.kind, u.status, u.last_login_at, u.created_at, u.updated_at,
    (coalesce(u.locked_until > ${now}, false) or coalesce(u.mfa_locked_until > ${now}, false)) as locked,
    exists (select 1 from platform.mfa_factor f where f.user_id = u.id and f.confirmed_at is not null and f.deleted_at is null) as mfa_enrolled,
    exists (select 1 from platform.platform_role r where r.user_id = u.id and r.role = 'platform_operator' and r.revoked_at is null) as platform_operator`;
}

/** The memberships of the accounts, by account: organisation, membership status and admin roles only. */
async function membershipsOf(trx: Trx, userIds: readonly string[]): Promise<Map<string, OpsAccountMembership[]>> {
  const out = new Map<string, OpsAccountMembership[]>();
  if (userIds.length === 0) return out;
  const rows = await trx
    .selectFrom('platform.org_membership as m')
    .innerJoin('platform.organization as o', 'o.id', 'm.organization_id')
    .select(['m.user_id', 'o.slug', 'o.name', 'm.status', 'm.admin_roles'])
    .where('m.user_id', 'in', [...userIds])
    .where('m.deleted_at', 'is', null)
    .where('o.deleted_at', 'is', null)
    .orderBy('o.position')
    .orderBy('o.name')
    .execute();
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push({ org: r.slug, orgName: r.name, status: r.status, adminRoles: [...r.admin_roles] as OpsAccountMembership['adminRoles'] });
    out.set(r.user_id, list);
  }
  return out;
}

function itemOf(row: AccountRow, memberships: OpsAccountMembership[]): OpsAccountItem {
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    mfaEnrolled: row.mfa_enrolled,
    locked: row.locked,
    lastSignInAt: row.last_login_at ? iso(row.last_login_at) : null,
    createdAt: iso(row.created_at),
    platformOperator: row.platform_operator,
    memberships,
    etag: etagOf(row.updated_at),
  };
}

/** The answer of an action. */
function result(
  id: string,
  status: AccountStatus,
  sessionsRevoked: number,
  emailed: boolean,
  message: [string, string],
  link: { link?: string; expiresAt?: string } = {},
): OpsAccountActionResult {
  return { ok: true, changed: [], message, data: { id, sessionsRevoked, emailed, status, ...link } };
}
