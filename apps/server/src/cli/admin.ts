import { Global, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Command } from 'commander';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ConfigModule } from '../config/config.module';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { ProblemError } from '../common/problems';
import { DatabaseModule } from '../db/database.module';
import { createKysely } from '../db/kysely';
import type { DB } from '../db/types';
import { AuditModule } from '../modules/audit/audit.module';
import { AuthzModule } from '../modules/authz/authz.module';
import { AccountMailer } from '../modules/identity/account-mailer';
import { IdentityModule } from '../modules/identity/identity.module';
import { handleBase, INVITATION_TTL_MS, InvitationService, type CreatedInvitation, type InvitedUser } from '../modules/identity/invitation.service';
import { randomToken, sha256 } from '../modules/identity/tokens';
import { KeysModule } from '../modules/keys/keys.module';
import { LicenseModule } from '../modules/license/license.module';
import { checkMailReadiness, mailRequiredMessage, type MailReadiness } from '../modules/ops/mail-readiness';
import { MetricsService } from '../modules/platform/metrics';
import { ReadinessService } from '../modules/platform/readiness.service';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { TenantScope } from '../modules/tenancy/tenant-scope';

// User administration from the command line (D-01, Milestone 2 D.2):
// - `admin create-user`: a user with an invited membership of an organisation and a one-time invitation link (F.4,
//   D-15). The link is emailed when mail works and printed only as a fallback; with `mail.required` (SaaS) the command
//   refuses while SMTP does not work and never prints the link.
// - `admin create-operator`: the platform operator account of a SaaS installation (A.2): the platform role
//   `platform_operator`, TOTP enrolment forced at the first sign-in, and a one-time link to set the password (token
//   kind `set_password`, 72 hours) sent by email, with the same mail rule. Audited `ops.operator_created`.
// - `admin revoke-operator`: ends the platform role and every session of the account (it signs in again with the
//   roles it keeps). Audited `ops.operator_revoked`.
// The operator commands write the platform role as the database owner (`mscd_migrator`, the application role only
// reads `platform.platform_role`), in one transaction with platform scope.

/** Validity of the set-password link of a new platform operator (the invitation's 72 hours). */
export const OPERATOR_LINK_TTL_MS = INVITATION_TTL_MS;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE = /^[a-z][a-z0-9._-]{1,39}$/;

export function register(program: Command): void {
  const admin = program.command('admin').description('User administration from the command line');
  admin
    .command('create-user')
    .description('Create a user and an invited membership of an organisation; the invitation (valid 72 hours) is emailed, or printed when mail is off')
    .requiredOption('--email <email>', 'email address of the user')
    .option('--name <name>', 'display name (default: the part of the email before @)')
    .option('--tenant-admin', 'grant the tenant_admin organisation role')
    .option('--org <slug>', 'organisation slug (default: the only organisation)')
    .action(async (options: CreateUserOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const result = await adminCreateUser(config, options);
        const lines = [
          `admin create-user: ${result.newAccount ? 'created user' : 'invited existing user'} ${result.handle} (${result.email}) ` +
            `to organisation ${result.orgSlug}${options.tenantAdmin ? ' as tenant_admin' : ''}`,
        ];
        if (result.emailed) {
          lines.push(`Invitation sent to ${result.email}`);
        } else if (config.profile.mail.required) {
          // Never reached: the command refuses before anything is created when mail does not work.
          lines.push(`The invitation email to ${result.email} could not be sent; run the command again when mail works`);
        } else {
          lines.push(`Mail is not configured, so give this one-time invitation link to the user (single use, valid until ${result.expiresAt.toISOString()}):`, result.link);
        }
        if (!result.newAccount) lines.push('The account already exists: accepting asks for its current password if it has one; the password is not replaced.');
        process.stdout.write(`${lines.join('\n')}\n`);
        if (!result.emailed && config.profile.mail.required) process.exit(1);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`admin create-user failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
  admin
    .command('create-operator')
    .description('Make an account a platform operator; a new account gets a one-time link to set its password (valid 72 hours) by email')
    .requiredOption('--email <email>', 'email address of the operator')
    .option('--name <name>', 'display name of a new account (default: the part of the email before @)')
    .action(async (options: CreateOperatorOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const result = await adminCreateOperator(config, options);
        const head = `admin create-operator: ${result.email} ${result.alreadyOperator ? 'is a platform operator' : 'is now a platform operator'}${result.newAccount ? ' (new account)' : ''}`;
        if (result.emailed) {
          process.stdout.write(`${head}\nInvitation sent to ${result.email}\n`);
        } else if (config.profile.mail.required) {
          process.stdout.write(`${head}\n`);
          process.stderr.write(`The invitation email to ${result.email} could not be sent; run the command again when mail works\n`);
          process.exit(1);
        } else if (result.link && result.expiresAt) {
          process.stdout.write(
            `${head}\nMail is not configured, so give this one-time link to set the password to the operator (single use, valid until ${result.expiresAt.toISOString()}):\n${result.link}\n` +
              'At the first sign-in the operator sets up an authenticator app.\n',
          );
        } else {
          process.stdout.write(`${head}\nThe account signs in with its current password and an authenticator app.\n`);
        }
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`admin create-operator failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
  admin
    .command('revoke-operator')
    .description('End the platform operator role of an account and its sessions')
    .requiredOption('--email <email>', 'email address of the operator')
    .action(async (options: RevokeOperatorOptions) => {
      const config = loadConfigOrExit('cli');
      try {
        const result = await adminRevokeOperator(config, options);
        process.stdout.write(
          `admin revoke-operator: ${result.email} is no longer a platform operator; ${result.sessionsRevoked} session(s) ended` +
            `${result.operatorsLeft === 0 ? '. No platform operator is left: create one with "mscd-server admin create-operator"' : ''}\n`,
        );
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`admin revoke-operator failed: ${describeError(error)}\n`);
        process.exit(1);
      }
    });
}

export interface CreateUserOptions {
  email: string;
  name?: string;
  tenantAdmin?: boolean;
  org?: string;
}

export interface CreateUserResult extends Omit<InvitedUser, 'invitation'>, CreatedInvitation {
  orgSlug: string;
  /** True when the invitation email was sent. */
  emailed: boolean;
}

/** The message of a refusal: problem details carry the reason in their messages or detail. */
function describeError(error: unknown): string {
  if (error instanceof ProblemError) {
    const reason = error.extras.messages?.en ?? error.extras.detail ?? error.message;
    const fields = error.extras.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return `${error.extras.rule ? `${error.extras.rule}: ` : ''}${reason}${fields ? ` (${fields})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Readiness and metrics services the database module expects, without the HTTP and metrics listeners. */
@Global()
@Module({ providers: [ReadinessService, MetricsService], exports: [ReadinessService, MetricsService] })
class CliPlatformModule {}

/**
 * The modules a command needs to create users: database, tenancy (with the common services, whose notification
 * writer needs the membership service of authz), audit, keys, identity and the licence gate.
 */
@Module({})
class AdminCliModule {
  static forRoot(config: MscdConfig): DynamicModule {
    return {
      module: AdminCliModule,
      imports: [
        ConfigModule.forRoot(config),
        CliPlatformModule,
        DatabaseModule,
        TenancyModule,
        AuditModule,
        KeysModule,
        AuthzModule,
        IdentityModule,
        LicenseModule,
      ],
    };
  }
}

/** A Nest application context for user administration commands (run mode `cli`, no listeners). */
export async function createAdminContext(config: MscdConfig): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AdminCliModule.forRoot(config), { logger: ['error'], abortOnError: false });
}

/** The mail rule of the onboarding commands: with `mail.required`, refuse while SMTP does not work (D.2). */
async function mailForOnboarding(config: MscdConfig, readiness?: MailReadiness): Promise<MailReadiness> {
  const mail = readiness ?? (await checkMailReadiness(config));
  if (!mail.ok && config.profile.mail.required) throw new Error(mailRequiredMessage(mail.reason));
  return mail;
}

/**
 * `admin create-user` with a loaded configuration: creates the user (or invites an existing account) with an
 * `invited` membership, after `LicenceGate.assertCanAddUser`, and emails the invitation link when mail works (D.2).
 * The operator gets a link also for an account that is already active (`linkForActiveAccount`, for example a person
 * who left every organisation and cannot sign in to accept a membership); such a link is accepted with the account's
 * current password, which it never replaces. With `mail.required` the command refuses before anything is written
 * while SMTP does not work. `context` replaces the application context the command builds, `mail` the SMTP check
 * (tests).
 */
export async function adminCreateUser(
  config: MscdConfig,
  options: CreateUserOptions,
  context?: INestApplicationContext,
  mail?: MailReadiness,
): Promise<CreateUserResult> {
  const readiness = await mailForOnboarding(config, mail);
  const app = context ?? (await createAdminContext(config));
  try {
    const scope = app.get(TenantScope, { strict: false });
    const invitations = app.get(InvitationService, { strict: false });
    const mailer = app.get(AccountMailer, { strict: false });
    const org = await scope.withPlatform(
      async (trx) => {
        const query = trx.selectFrom('platform.organization').select(['id', 'slug', 'name']).where('deleted_at', 'is', null);
        if (options.org) {
          const found = await query.where('slug', '=', options.org).executeTakeFirst();
          if (!found) throw new Error(`No organisation with slug ${options.org}`);
          return found;
        }
        const all = await query.orderBy('slug').limit(2).execute();
        if (all.length !== 1) {
          throw new Error(all.length === 0 ? 'No organisation exists yet; run "mscd-server tenant create" first' : 'Several organisations exist; name one with --org <slug>');
        }
        return all[0]!;
      },
      { scope: 'cli' },
    );
    const invited = await scope.withPlatform(
      (trx) =>
        invitations.inviteUser(trx, {
          orgId: org.id,
          email: options.email,
          displayName: options.name ?? null,
          adminRoles: options.tenantAdmin ? ['tenant_admin'] : [],
          actor: { userId: null, kind: 'operator' },
          linkForActiveAccount: true,
        }),
      { scope: 'cli', orgId: org.id },
    );
    const { invitation, ...user } = invited;
    if (!invitation) throw new Error('No invitation link was issued');
    const emailed = readiness.ok
      ? await mailer.send({
          to: { email: user.email, userId: user.userId },
          template: { name: 'invitation', link: invitation.link, organisation: org.name, hours: INVITATION_TTL_MS / 3_600_000 },
        })
      : false;
    return { ...user, ...invitation, orgSlug: org.slug, emailed };
  } finally {
    if (!context) await app.close();
  }
}

export interface CreateOperatorOptions {
  email: string;
  name?: string;
}

export interface CreateOperatorResult {
  userId: string;
  handle: string;
  email: string;
  newAccount: boolean;
  /** The account held the role already (a new link is issued while it has no password yet). */
  alreadyOperator: boolean;
  /** One-time link to set the password (`<public_url>/reset-password#token=...`); null for an account with a password. */
  link: string | null;
  token: string | null;
  expiresAt: Date | null;
  emailed: boolean;
}

/** The migrator connection of the operator commands (the application role only reads `platform.platform_role`). */
async function asOwner<T>(config: MscdConfig, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  const owner: Kysely<DB> = createKysely<DB>({ connectionString: config.databaseUrl('migrator'), max: 1, applicationName: 'mscd-admin-operator' });
  try {
    return await owner.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true)`.execute(trx);
      return fn(trx);
    });
  } finally {
    await owner.destroy();
  }
}

/** One `platform.audit_log` entry of an operator command (actor kind `operator`, no organisation). */
async function auditOperatorCommand(trx: Transaction<DB>, action: 'ops.operator_created' | 'ops.operator_revoked', user: { id: string; handle: string }, after: Record<string, unknown>): Promise<void> {
  await trx
    .insertInto('platform.audit_log')
    .values({
      organization_id: null,
      actor_user_id: null,
      actor_kind: 'operator',
      action,
      entity_type: 'user',
      entity_id: user.id,
      entity_code: user.handle,
      after_data: JSON.stringify(after),
    })
    .execute();
}

/** A free handle from the email's local part, as `InvitationService` chooses one. */
async function uniqueHandle(trx: Transaction<DB>, email: string): Promise<string> {
  const base = handleBase(email);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!HANDLE.test(candidate)) continue;
    const taken = await trx.selectFrom('platform.app_user').select('id').where('handle', '=', candidate).executeTakeFirst();
    if (!taken) return candidate;
  }
  throw new Error('No free user handle for this email address');
}

/**
 * `admin create-operator` with a loaded configuration (Milestone 2 A.2, D.2): a new account (active, no password,
 * TOTP required) or an existing one gets the platform role `platform_operator`. An account without a password gets a
 * one-time link to set it (token kind `set_password`, 72 hours; older unused links stop working), emailed when mail
 * works. With `mail.required` the command refuses before anything is written while SMTP does not work. Refused for a
 * disabled account and for an operator that already has a password. `context` and `mail` replace the application
 * context and the SMTP check (tests).
 */
export async function adminCreateOperator(
  config: MscdConfig,
  options: CreateOperatorOptions,
  context?: INestApplicationContext,
  mail?: MailReadiness,
): Promise<CreateOperatorResult> {
  const email = options.email.trim();
  if (email.length > 254 || !EMAIL.test(email)) throw new Error(`${JSON.stringify(options.email)} is not an email address`);
  const name = options.name?.trim();
  if (name !== undefined && (name === '' || name.length > 150)) throw new Error('--name must have 1 to 150 characters');
  const readiness = await mailForOnboarding(config, mail);
  const app = context ?? (await createAdminContext(config));
  try {
    const mailer = app.get(AccountMailer, { strict: false });
    const done = await asOwner(config, async (trx) => {
      const now = new Date();
      const existing = await trx
        .selectFrom('platform.app_user')
        .select(['id', 'handle', 'email', 'status', 'kind', 'password_hash'])
        .where(sql<string>`lower(email)`, '=', email.toLowerCase())
        .where('kind', '<>', 'guest')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.kind === 'system') throw new Error('This email address belongs to a system account');
      if (existing?.status === 'disabled') throw new Error('The account of this email address is disabled; enable it first');
      let user: { id: string; handle: string; email: string; passwordSet: boolean };
      if (existing) {
        // An invited account that never signed in becomes active: the set-password link replaces its invitation.
        await trx.updateTable('platform.app_user').set({ mfa_required: true, status: 'active' }).where('id', '=', existing.id).execute();
        user = { id: existing.id, handle: existing.handle, email: existing.email, passwordSet: existing.password_hash !== null };
      } else {
        const handle = await uniqueHandle(trx, email);
        const created = await trx
          .insertInto('platform.app_user')
          .values({ handle, email, display_name: name ?? (email.split('@')[0] ?? handle), kind: 'person', status: 'active', mfa_required: true })
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
      if (alreadyOperator && user.passwordSet) throw new Error(`${user.email} is already a platform operator`);
      if (!role) {
        await trx.insertInto('platform.platform_role').values({ user_id: user.id, role: 'platform_operator', granted_at: now }).execute();
      } else if (!alreadyOperator) {
        await trx
          .updateTable('platform.platform_role')
          .set({ revoked_at: null, granted_at: now, granted_by: null })
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
      await auditOperatorCommand(trx, 'ops.operator_created', user, {
        email: user.email,
        newAccount: !existing,
        roleGranted: !alreadyOperator,
        setPasswordLink: token !== null,
        ...(expiresAt ? { linkExpiresAt: expiresAt.toISOString() } : {}),
        mfaRequired: true,
      });
      return { user, newAccount: !existing, alreadyOperator, token, expiresAt };
    });
    const link = done.token ? mailer.appLink(`/reset-password#token=${done.token}`) : null;
    const emailed = readiness.ok
      ? await mailer.send({
          to: { email: done.user.email, userId: done.user.id },
          template: link ? { name: 'operator_invitation', link, hours: OPERATOR_LINK_TTL_MS / 3_600_000 } : { name: 'operator_granted', link: mailer.appLink('/login') },
        })
      : false;
    return {
      userId: done.user.id,
      handle: done.user.handle,
      email: done.user.email,
      newAccount: done.newAccount,
      alreadyOperator: done.alreadyOperator,
      link,
      token: done.token,
      expiresAt: done.expiresAt,
      emailed,
    };
  } finally {
    if (!context) await app.close();
  }
}

export interface RevokeOperatorOptions {
  email: string;
}

export interface RevokeOperatorResult {
  userId: string;
  email: string;
  sessionsRevoked: number;
  /** Platform operators left after the change. */
  operatorsLeft: number;
}

/**
 * `admin revoke-operator` with a loaded configuration: ends the role `platform_operator` of the account and every
 * session of it (reason `roles_changed`); its memberships stay. Refused when the account holds no active operator
 * role.
 */
export async function adminRevokeOperator(config: MscdConfig, options: RevokeOperatorOptions): Promise<RevokeOperatorResult> {
  const email = options.email.trim().toLowerCase();
  return asOwner(config, async (trx) => {
    const now = new Date();
    const user = await trx
      .selectFrom('platform.app_user')
      .select(['id', 'handle', 'email'])
      .where(sql<string>`lower(email)`, '=', email)
      .where('kind', '<>', 'guest')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user) throw new Error(`No account has the email address ${options.email}`);
    const revoked = await trx
      .updateTable('platform.platform_role')
      .set({ revoked_at: now })
      .where('user_id', '=', user.id)
      .where('role', '=', 'platform_operator')
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(revoked.numUpdatedRows) === 0) throw new Error(`${user.email} is not a platform operator`);
    const sessions = await trx
      .updateTable('platform.session')
      .set({ revoked_at: now, revoke_reason: 'roles_changed' })
      .where('user_id', '=', user.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const left = await trx
      .selectFrom('platform.platform_role')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('role', '=', 'platform_operator')
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    await auditOperatorCommand(trx, 'ops.operator_revoked', user, { email: user.email, sessionsRevoked: Number(sessions.numUpdatedRows) });
    return { userId: user.id, email: user.email, sessionsRevoked: Number(sessions.numUpdatedRows), operatorsLeft: Number(left.n) };
  });
}
