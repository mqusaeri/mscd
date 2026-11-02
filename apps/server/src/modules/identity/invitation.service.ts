// Invitations (build plan F.4, F.6, D-25, D-15): a user and an `invited` membership, plus a single-use token valid
// for 72 hours whose link `<public_url>/invite#token=...` is handed to the invitee. Redeeming it by setting a
// password (`POST /auth/invitations/accept`) activates the account and the membership (checked against the licence
// user limit in the same transaction) and continues to MFA enrolment. An account that is already active gets only
// the `invited` membership, which its owner accepts after signing in (F.6, `POST /me/memberships/{org}/accept`),
// unless the platform operator asks for a link (`admin create-user`); such a link is redeemed with the account's
// current password and never replaces it. The provider path (signing in through one of the inviting organisation's
// identity providers with `?invitation=`) is WP-16's.
//
// Milestone 2 (D.2, J.4): an existing active account that gets an invited membership is told by the account email
// `membership_invited` and by the in-app notification `membership_invited` in the organisation the account signs in
// to, so the invitation does not wait unseen.
//
// Milestone 3 H.13 (D.6.5): a person erased in an organisation who is invited there again rejoins with a fresh account
// and membership. The erased account, its removed membership, its pseudonym (`erased_person`) and every record that
// names it stay as they are, so the records from before the erasure keep the pseudonym and the new account shows no
// link to it. `releaseErasedAccount` decides what an invitation of such an email address does (see there); both
// invitation paths (`inviteUser` here and `POST /admin/users`) call it before they look at the membership, so a
// removed membership of an erased person is never revived.
import { Injectable, Logger } from '@nestjs/common';
import type { InvitationAcceptRequest, LoginResponse, OrgRole } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { ConflictError, NotFoundError, ProblemError, UnauthenticatedError, ValidationError } from '../../common/problems';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';
import { afterCommit } from '../../common/transaction-hooks';
import { TENANT_SCHEMA } from '../tenancy/tenant-scope';
import { AccountAnonymiser } from './account-anonymiser';
import { AccountMailer } from './account-mailer';
import { AuthService, invalidCredentials, invalidLinkToken, normaliseEmail } from './auth.service';
import { checkPassword } from './credentials';
import { IdentityInfra } from './identity-infra';
import { localLoginAllowed, providerMethods } from './local-login-policy';
import { MfaService } from './mfa.service';
import { hashSecret } from './password-hasher';
import { passwordProblems } from './password-policy';
import { SessionService } from './session.service';
import { principalUser, SignInResponder } from './sign-in-responder';
import { randomToken, sha256 } from './tokens';

/** Validity of an invitation (F.4). */
export const INVITATION_TTL_MS = 72 * 3_600_000;

/** Who creates an invitation: a signed-in user (Tenant Admin) or the operator at the command line. */
export interface InvitationActor {
  userId: string | null;
  kind: 'user' | 'operator' | 'system';
}

export interface InviteUserInput {
  orgId: string;
  email: string;
  displayName?: string | null;
  jobTitle?: string | null;
  adminRoles?: OrgRole[];
  actor: InvitationActor;
  /**
   * Also issue an invitation link for an account that is already active (the operator's `admin create-user`, for
   * example for a person who left every organisation and cannot sign in to accept a membership). Default false: as
   * F.6 describes for `POST /admin/users`, an active account gets only the `invited` membership.
   */
  linkForActiveAccount?: boolean;
}

export interface CreatedInvitation {
  invitationId: string;
  /** The token, shown once (only its hash is stored). */
  token: string;
  /** `<public_url>/invite#token=<token>`. */
  link: string;
  expiresAt: Date;
}

export interface InvitedUser {
  userId: string;
  handle: string;
  email: string;
  /** True when the account was created now; false when an existing account got an invited membership. */
  newAccount: boolean;
  /**
   * The invitation link for a new account or an account that was never activated (or, with `linkForActiveAccount`,
   * for an active one); null when an active account got only the `invited` membership (F.6).
   */
  invitation: CreatedInvitation | null;
}

const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A handle candidate from the local part of an email: lower case, letters, digits, `.`, `_` and `-` only. */
export function handleBase(email: string): string {
  const local = email.split('@')[0] ?? '';
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z]+/, '')
    .replace(/[._-]+$/, '');
  if (base.length > 34) base = base.slice(0, 34).replace(/[._-]+$/, '');
  if (base.length < 2) base = `user${base}`;
  return base;
}

/**
 * Milestone 3 H.13: the refusal of an invitation of an email address whose account was erased in the organisation and
 * still belongs to the person elsewhere (a membership of another organisation, or the platform operator role). An email
 * address names one account only (C.4), so the fresh account the person rejoins with needs another email address.
 */
export const ERASED_PERSON_INVITATION = {
  key: 'invitation.erased_person',
  en: 'This email address belongs to a person who was erased in this organisation, and it cannot be used for a new invitation here. Invite the person with a different email address: they join with a fresh account.',
  id: 'Alamat email ini milik orang yang telah dihapus di organisasi ini dan tidak dapat dipakai untuk undangan baru di sini. Undang orang tersebut dengan alamat email lain: mereka bergabung dengan akun baru.',
} as const;

/** 422 `business-rule` with messageKey `invitation.erased_person` (H.13). */
export function erasedPersonInvitationRefused(): ProblemError {
  const { key, en, id } = ERASED_PERSON_INVITATION;
  return new ProblemError('business-rule', { messageKey: key, detail: en, messages: { en, id } });
}

/**
 * Whether the account is erased in the organisation (Milestone 3 D.6.5): a live row of the organisation's
 * `erased_person`. Works in a tenant transaction and in platform scope alike: the table is read in the organisation's
 * schema with `app.org_id` of the organisation for this one statement (the row-level policy of tenant tables), and the
 * previous value is restored afterwards.
 */
export async function erasedInOrganisation(trx: Trx, orgId: string, userId: string): Promise<boolean> {
  const org = await trx.selectFrom('platform.organization').select('schema_name').where('id', '=', orgId).executeTakeFirst();
  if (!org || !TENANT_SCHEMA.test(org.schema_name)) return false;
  const { rows } = await sql<{ prev: string }>`select coalesce(current_setting('app.org_id', true), '') as prev`.execute(trx);
  const previous = rows[0]?.prev ?? '';
  const switched = previous !== orgId;
  if (switched) await sql`select set_config('app.org_id', ${orgId}, true)`.execute(trx);
  let found: boolean;
  try {
    const { rows: erased } = await sql<{ one: number }>`
      select 1 as one from ${sql.table(`${org.schema_name}.erased_person`)} e
       where e.erased_user_id = ${userId}::uuid and e.deleted_at is null`.execute(trx);
    found = erased.length > 0;
  } catch (error) {
    // After a database error the transaction is aborted and rolls back anyway; the original error is what matters.
    if (switched) await sql`select set_config('app.org_id', ${previous}, true)`.execute(trx).catch(() => undefined);
    throw error;
  }
  if (switched) await sql`select set_config('app.org_id', ${previous}, true)`.execute(trx);
  return found;
}

/** What `notifyInvitedAccount` needs: the account, the inviting organisation and who invited. */
export interface InvitedAccountNotice {
  userId: string;
  email: string;
  orgId: string;
  orgName: string;
  /** Display name of the person who invited; null for an operator command. */
  invitedBy: string | null;
  /** `created_by` of the notification (default: the system user). */
  actorUserId?: string | null;
}

/** The texts of the `membership_invited` notification (J.4). */
export function membershipInvitedTexts(orgName: string, invitedBy: string | null): { title: [string, string]; body: [string, string] } {
  return {
    title: [`Invitation to ${orgName}`, `Undangan ke ${orgName}`],
    body: [
      invitedBy
        ? `${invitedBy} invited you to join ${orgName}. You can accept or decline the invitation in MSCD.`
        : `You were invited to join ${orgName}. You can accept or decline the invitation in MSCD.`,
      invitedBy
        ? `${invitedBy} mengundang Anda untuk bergabung dengan ${orgName}. Anda dapat menerima atau menolak undangan di MSCD.`
        : `Anda diundang untuk bergabung dengan ${orgName}. Anda dapat menerima atau menolak undangan di MSCD.`,
    ],
  };
}

@Injectable()
export class InvitationService {
  private readonly logger = new Logger('Invitations');

  constructor(
    private readonly infra: IdentityInfra,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly responder: SignInResponder,
    private readonly mailer: AccountMailer,
    private readonly anonymiser: AccountAnonymiser,
  ) {}

  /**
   * Milestone 3 H.13 (D.6.5): what an invitation does with an account found by the invited email address that is erased
   * in the inviting organisation. The person rejoins with a fresh account and membership; the erased account, its
   * removed membership, its pseudonym and every record that names it are never changed here. Answers:
   * - false: the account is not erased in the organisation, and the ordinary invitation goes on;
   * - true: the account is erased in the organisation and nothing keeps it any more (it was kept at the erasure for a
   *   membership of another organisation that has ended since): it is anonymised now in `trx`, as step 5 of the erasure
   *   would have done then (`AccountAnonymiser`, audited `user.anonymised`), so the email address is free and the caller
   *   creates a fresh account with it;
   * - otherwise 422 `invitation.erased_person` (`ERASED_PERSON_INVITATION`): the account still belongs to the person in
   *   another organisation (a live or invited membership) or is a platform operator's, or it is anonymised already
   *   (its `erased.invalid` address was given). An email address names one account (C.4) and sign-in finds the account
   *   by it, so a fresh account with this address cannot exist next to the kept one; the person rejoins with a fresh
   *   account under another email address.
   */
  async releaseErasedAccount(trx: Trx, orgId: string, userId: string, actor: InvitationActor): Promise<boolean> {
    if (!(await erasedInOrganisation(trx, orgId, userId))) return false;
    const anonymised = await this.anonymiser.anonymise(trx, userId, {
      reason: 'Erased in this organisation and invited again; no other membership keeps the account (H.13)',
      organizationId: orgId,
      leavingOrgId: orgId,
      actor,
    });
    if (!anonymised) throw erasedPersonInvitationRefused();
    return true;
  }

  /** The invitation link of a token. */
  invitationLink(token: string): string {
    return this.mailer.appLink(`/invite#token=${token}`);
  }

  /**
   * When the pending invitations of a user were made (Milestone 2 D.2 `Me.pendingMemberships[].invitedAt`): per
   * organisation of `orgIds`, the time of the latest `user.invited` entry for the user (entity `user`, or entity
   * `invitation` naming one of the user's invitation links). The membership row is no clock for this: a trigger moves
   * its `updated_at` on every change of the invited row (its admin roles, for example), and its `created_at` stays
   * from a former membership that was invited again. The entries belong to organisations the session is not bound
   * to, so they are read in platform scope, read only. Organisations without such an entry (seeded data) are left out.
   */
  async invitationTimes(userId: string, orgIds: readonly string[]): Promise<Map<string, Date>> {
    const times = new Map<string, Date>();
    if (orgIds.length === 0) return times;
    const rows = await this.infra.scope.withPlatform(
      async (trx) => {
        await sql`set transaction read only`.execute(trx);
        return trx
          .selectFrom('platform.audit_log as a')
          .select(['a.organization_id', (eb) => eb.fn.max('a.occurred_at').as('at')])
          .where('a.action', '=', 'user.invited')
          .where('a.organization_id', 'in', [...orgIds])
          .where((eb) =>
            eb.or([
              eb.and([eb('a.entity_type', '=', 'user'), eb('a.entity_id', '=', userId)]),
              eb.and([
                eb('a.entity_type', '=', 'invitation'),
                eb('a.entity_id', 'in', eb.selectFrom('platform.invitation as i').select('i.id').where('i.user_id', '=', userId)),
              ]),
            ]),
          )
          .groupBy('a.organization_id')
          .execute();
      },
      { scope: 'auth', userId },
    );
    for (const r of rows) if (r.organization_id && r.at) times.set(r.organization_id, new Date(r.at));
    return times;
  }

  /**
   * Tells an existing active account about an invited membership (Milestone 2 D.2, J.4), after `trx` commits: the
   * account email `membership_invited`, and the notification `membership_invited` in the organisation the account
   * signs in to (its default active membership, else its first active one; none when it has no other active
   * membership). The notification is stored with `email_status = 'skipped'`, because the account email already
   * carries the message. Failures are logged and never undo the invitation.
   */
  notifyInvitedAccount(trx: Trx, notice: InvitedAccountNotice): void {
    this.mailer.sendAfterCommit(trx, {
      to: { email: notice.email, userId: notice.userId },
      template: { name: 'membership_invited', link: this.mailer.appLink('/'), organisation: notice.orgName, invitedBy: notice.invitedBy },
    });
    afterCommit(trx, async () => {
      try {
        await this.writeInvitedNotification(notice);
      } catch (error) {
        this.logger.error(
          { userId: notice.userId, orgId: notice.orgId },
          `Could not write the membership_invited notification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  /** The notification of `notifyInvitedAccount` in the account's home organisation; returns its id, or null. */
  private async writeInvitedNotification(notice: InvitedAccountNotice): Promise<string | null> {
    const home = await this.infra.scope.withPlatform(
      async (trx) => {
        const { rows } = await sql<{ id: string; schema_name: string }>`
          select o.id, o.schema_name
            from platform.org_membership m
            join platform.organization o on o.id = m.organization_id
           where m.user_id = ${notice.userId} and m.status = 'active' and m.deleted_at is null
             and m.organization_id <> ${notice.orgId}
             and o.deleted_at is null and o.status in ('active', 'offboarding')
           order by m.is_default desc, o.position, o.name
           limit 1`.execute(trx);
        return rows[0] ?? null;
      },
      { scope: 'auth', userId: notice.userId },
    );
    if (!home) return null;
    const texts = membershipInvitedTexts(notice.orgName, notice.invitedBy);
    const actor = notice.actorUserId ?? SYSTEM_USER_ID;
    return this.infra.scope.withTenant({ orgId: home.id, schema: home.schema_name, userId: actor }, async (trx) => {
      const row = await trx
        .insertInto('notification')
        .values({
          recipient_user_id: notice.userId,
          management_system_id: null,
          kind: 'membership_invited',
          title_en: texts.title[0],
          title_id: texts.title[1],
          body_en: texts.body[0],
          body_id: texts.body[1],
          entity_ref: null,
          digest: false,
          email_status: 'skipped',
          created_by: actor,
          updated_by: actor,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /** Writes an invitation for an existing user and membership (72 hours, single use). */
  async createInvitation(trx: Trx, input: { orgId: string; userId: string; email: string; createdBy: string | null }): Promise<CreatedInvitation> {
    const now = this.infra.clock.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const row = await trx
      .insertInto('platform.invitation')
      .values({
        token_hash: sha256(token),
        organization_id: input.orgId,
        user_id: input.userId,
        email: input.email,
        created_by: input.createdBy ?? SYSTEM_USER_ID,
        created_at: now,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { invitationId: row.id, token, link: this.invitationLink(token), expiresAt };
  }

  /**
   * Creates (or re-invites) a user of an organisation with an `invited` membership, checking the licence user limit
   * (D-15 `LIC-USERS`). A new account, or one that was never activated (status `invited`), also gets an invitation;
   * an active account gets one only with `linkForActiveAccount` (F.6). Runs in the caller's transaction, which must
   * have platform scope or `app.org_id` of the organisation. A user that is already an active member is a 409
   * `conflict`. An email address of a person erased in the organisation gives a fresh account or a 422 (H.13,
   * `releaseErasedAccount`); the erased account's removed membership is never revived.
   */
  async inviteUser(trx: Trx, input: InviteUserInput): Promise<InvitedUser> {
    const email = input.email.trim();
    if (email.length > 254 || !EMAIL.test(email)) throw new ValidationError([{ path: 'email', message: 'Not a valid email address' }]);
    const now = this.infra.clock.now();
    const org = await trx.selectFrom('platform.organization').select(['id', 'name']).where('id', '=', input.orgId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!org) throw new NotFoundError('Unknown organisation');
    const adminRoles = [...new Set(input.adminRoles ?? [])];
    const actorUserId = input.actor.userId;

    await this.infra.licence.assertCanAddUser(trx, org.id);
    let existing = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email', 'status'])
      .where(sql<string>`lower(email)`, '=', normaliseEmail(email))
      .where('kind', '<>', 'guest')
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    // H.13: an account erased in this organisation is anonymised (true, a fresh account follows) or refused (422).
    if (existing && (await this.releaseErasedAccount(trx, org.id, existing.id, input.actor))) existing = undefined;

    let user: { id: string; handle: string; email: string };
    let newAccount = false;
    let issueLink = true;
    if (existing) {
      if (existing.status === 'disabled') throw new ConflictError('The account of this email address is disabled');
      const membership = await trx
        .selectFrom('platform.org_membership')
        .select(['status', 'deleted_at'])
        .where('organization_id', '=', org.id)
        .where('user_id', '=', existing.id)
        .forUpdate()
        .executeTakeFirst();
      if (membership && membership.status === 'active' && membership.deleted_at === null) {
        throw new ConflictError('This user is already an active member of the organisation');
      }
      if (membership) {
        await trx
          .updateTable('platform.org_membership')
          .set({ status: 'invited', deleted_at: null, admin_roles: adminRoles, invited_by: actorUserId, accepted_at: null })
          .where('organization_id', '=', org.id)
          .where('user_id', '=', existing.id)
          .execute();
      } else {
        await trx
          .insertInto('platform.org_membership')
          .values({ organization_id: org.id, user_id: existing.id, status: 'invited', admin_roles: adminRoles, invited_by: actorUserId, is_default: !(await this.hasMembership(trx, existing.id)) })
          .execute();
      }
      user = existing;
      issueLink = existing.status !== 'active' || input.linkForActiveAccount === true;
    } else {
      const handle = await this.uniqueHandle(trx, email);
      user = await trx
        .insertInto('platform.app_user')
        .values({
          handle,
          email,
          display_name: input.displayName?.trim() || (email.split('@')[0] ?? handle),
          job_title: input.jobTitle?.trim() || null,
          kind: 'person',
          status: 'invited',
          mfa_required: true,
          created_by: actorUserId,
          updated_by: actorUserId,
        })
        .returning(['id', 'handle', 'email'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('platform.org_membership')
        .values({ organization_id: org.id, user_id: user.id, status: 'invited', admin_roles: adminRoles, invited_by: actorUserId, is_default: true })
        .execute();
      newAccount = true;
      await this.infra.audit.record(trx, {
        action: 'user.created',
        actor: input.actor,
        organizationId: org.id,
        entityType: 'user',
        entityId: user.id,
        entityCode: user.handle,
        after: { handle: user.handle, email: user.email, status: 'invited' },
      });
    }

    const invitation = issueLink ? await this.createInvitation(trx, { orgId: org.id, userId: user.id, email: user.email, createdBy: actorUserId }) : null;
    await this.infra.audit.record(trx, {
      action: 'user.invited',
      actor: input.actor,
      organizationId: org.id,
      entityType: invitation ? 'invitation' : 'user',
      entityId: invitation ? invitation.invitationId : user.id,
      entityCode: user.handle,
      after: {
        userId: user.id,
        adminRoles,
        newAccount,
        link: invitation !== null,
        ...(invitation ? { expiresAt: invitation.expiresAt.toISOString() } : {}),
        at: now.toISOString(),
      },
    });
    return { userId: user.id, handle: user.handle, email: user.email, newAccount, invitation };
  }

  /**
   * `POST /auth/invitations/accept` (F.4): redeems the token and opens a session that continues to MFA enrolment
   * (or the second factor for an account that has one). An account without a password sets one here (policy
   * checked). An account that has a password must give it: it is checked with the account lockout and never
   * replaced, so a link sent to an existing account proves the password as a sign-in does. Refused with
   * `auth.sso_required` when the inviting organisation does not allow local sign-in for the user; the invitation
   * stays usable through its providers.
   */
  async accept(request: FastifyRequest, reply: FastifyReply, body: InvitationAcceptRequest): Promise<LoginResponse> {
    const now = this.infra.clock.now();
    const presented = this.sessions.readCookie(request);
    const outcome = await this.infra.scope.withPlatform(
      async (trx) => {
        const invalid = () => ({ error: invalidLinkToken('auth.invitation_invalid', 'invitation') as Error });
        const invitation = await trx
          .selectFrom('platform.invitation')
          .selectAll()
          .where('token_hash', '=', sha256(body.token))
          .forUpdate()
          .executeTakeFirst();
        if (!invitation || invitation.used_at !== null || invitation.revoked_at !== null || invitation.expires_at.getTime() <= now.getTime()) return invalid();
        const user = await trx
          .selectFrom('platform.app_user')
          .select(['id', 'handle', 'email', 'display_name', 'job_title', 'kind', 'status', 'password_hash', 'failed_login_count', 'locked_until', 'mfa_required'])
          .where('id', '=', invitation.user_id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!user || user.kind !== 'person' || user.status === 'disabled') return invalid();
        const org = await trx
          .selectFrom('platform.organization')
          .select(['id', 'local_login', 'status'])
          .where('id', '=', invitation.organization_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const membership = await trx
          .selectFrom('platform.org_membership')
          .select(['status', 'admin_roles', 'deleted_at'])
          .where('organization_id', '=', invitation.organization_id)
          .where('user_id', '=', user.id)
          .forUpdate()
          .executeTakeFirst();
        if (!org || org.status === 'archived' || org.status === 'deleted' || !membership || membership.deleted_at !== null || membership.status === 'disabled') return invalid();
        if (!localLoginAllowed(org.local_login, membership.admin_roles)) {
          const methods = await providerMethods(trx, [org.id]);
          return {
            error: new UnauthenticatedError({
              messageKey: 'auth.sso_required',
              detail: 'This organisation requires single sign-on; accept the invitation by signing in with one of its identity providers',
              methods,
            }) as Error,
          };
        }
        const hadPassword = user.password_hash !== null;
        if (!body.password) {
          const message = hadPassword ? 'Enter the password of your account to accept the invitation' : 'Choose a password to accept the invitation';
          return { error: new ValidationError([{ path: 'body.password', message }]) as Error };
        }
        if (hadPassword) {
          // The account's current password, checked as at sign-in (a failure counts towards the lockout and is kept).
          const check = await checkPassword(trx, user, body.password, now);
          if (check.kind !== 'ok') {
            await this.infra.audit.record(trx, {
              action: 'auth.login_failed',
              actor: { userId: null, kind: 'user' },
              organizationId: org.id,
              entityType: 'user',
              entityId: user.id,
              after: { method: 'local', via: 'invitation', reason: check.kind === 'locked' ? 'locked' : 'wrong_password' },
            });
            return { error: invalidCredentials() as Error };
          }
        } else {
          const problems = passwordProblems(body.password, user, 'body.password');
          if (problems.length > 0) return { error: new ValidationError(problems, 'The new password does not meet the password policy') as Error };
        }

        if (membership.status !== 'active') {
          await this.infra.licence.assertCanAddUser(trx, org.id);
          await trx
            .updateTable('platform.org_membership')
            .set({ status: 'active', accepted_at: now })
            .where('organization_id', '=', org.id)
            .where('user_id', '=', user.id)
            .execute();
        }
        await trx
          .updateTable('platform.app_user')
          .set({
            status: 'active',
            ...(hadPassword ? {} : { password_hash: await hashSecret(body.password), password_changed_at: now, failed_login_count: 0, locked_until: null }),
          })
          .where('id', '=', user.id)
          .execute();
        await trx.updateTable('platform.invitation').set({ used_at: now }).where('id', '=', invitation.id).execute();
        await this.infra.audit.record(trx, {
          action: 'membership.updated',
          actor: { userId: user.id, kind: 'user' },
          organizationId: org.id,
          entityType: 'user',
          entityId: user.id,
          entityCode: user.handle,
          before: { status: membership.status },
          after: { status: 'active', via: 'invitation', invitationId: invitation.id },
        });
        const state = !this.auth.secondFactorRequired(user) ? 'active' : (await this.mfa.hasConfirmedFactor(trx, user.id)) ? 'mfa_pending' : 'mfa_enrolment';
        if (presented) await this.sessions.revoke(trx, sha256(presented), 'signed_in_again');
        const issued = await this.sessions.create(trx, {
          userId: user.id,
          organizationId: org.id,
          authOrgId: org.id,
          state,
          authMethod: 'local',
          passwordAt: now,
        });
        if (state === 'active') await this.auth.recordLogin(trx, user.id, org.id, now, { via: 'invitation' });
        return { issued, user };
      },
      { scope: 'auth' },
    );
    if ('error' in outcome) throw outcome.error;
    return this.responder.respond(reply, outcome.issued, principalUser(outcome.user));
  }

  private async hasMembership(trx: Trx, userId: string): Promise<boolean> {
    const row = await trx.selectFrom('platform.org_membership').select('user_id').where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    return row !== undefined;
  }

  /** A free handle from the email's local part (`rina.kusuma`, then `rina.kusuma-2`, ...). */
  private async uniqueHandle(trx: Trx, email: string): Promise<string> {
    const base = handleBase(email);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!HANDLE.test(candidate)) continue;
      const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', candidate).executeTakeFirst();
      if (!taken) return candidate;
    }
    throw new ProblemError('conflict', { detail: 'No free user handle for this email address' });
  }
}
