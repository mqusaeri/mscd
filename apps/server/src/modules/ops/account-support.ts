// Helpers of the account and operator routes of the platform operator (Milestone 2 section L, M2-19):
// - the refusals of these routes, each a problem with a message key and a message pair (J.6 style);
// - `browserOf`: the browser and system of a session, read from its user agent, so the operator sees "Chrome 130,
//   Windows" and never the full user agent string;
// - `withOwner`: one transaction as the database owner (`mscd_migrator`) with platform scope, for the writes of
//   `platform.platform_role`, which the application role only reads (as `admin create-operator` does);
// - `revokeAllSessions`: ends every open session of an account with the reason `operator_revoked`;
// - `lockActiveOperators`: the lock that every decision about the last active platform operator takes first.
import { sql, type Transaction } from 'kysely';
import { ConflictError, DependencyUnavailableError, ForbiddenError, ProblemError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import type { Trx } from '../../common/tokens';
import { ConfigError, type MscdConfig } from '../../config/mscd-config';
import { createKysely } from '../../db/kysely';
import type { DB } from '../../db/types';
import { inPlatformScope } from '../identity/platform-scope';

/** `platform.session.revoke_reason` of the sessions an operator ends (`ops.accounts.sessions-revoke`), varchar(40). */
export const OPERATOR_REVOKED = 'operator_revoked';

/** 409 `conflict` with a message key and the message in both languages. */
export function conflict(messageKey: string, en: string, id: string): ConflictError {
  return new ConflictError(en, { messageKey, messages: { en, id } });
}

/** 404 `not-found` with a message key and the message in both languages. */
export function notFound(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('not-found', { detail: en, messageKey, messages: { en, id } });
}

/** 404 `unknown_account`: no account that is not deleted has this id. */
export function unknownAccount(): ProblemError {
  return notFound('unknown_account', 'This account does not exist or was deleted.', 'Akun ini tidak ada atau telah dihapus.');
}

/**
 * 403 `forbidden`: an operator never acts on their own account with these routes (reset the second factor, which
 * ends every session; end sessions; disable; remove the operator role). The person replaces their own authenticator
 * on My account.
 */
export function ownAccount(): ForbiddenError {
  const en = 'You cannot do this to your own account. Ask another platform operator.';
  return new ForbiddenError(en, { messageKey: 'own_account', messages: { en, id: 'Anda tidak dapat melakukan ini pada akun Anda sendiri. Mintalah operator platform lain.' } });
}

/** 409 `system_account`: the system account of the installation takes no action. */
export function systemAccount(): ConflictError {
  return conflict(
    'system_account',
    'This is a system account of the installation. It cannot sign in and takes no action.',
    'Ini akun sistem instalasi. Akun ini tidak dapat masuk dan tidak menerima tindakan apa pun.',
  );
}

/** 409 `last_operator`: the service keeps at least one active platform operator. */
export function lastOperator(): ConflictError {
  return conflict(
    'last_operator',
    'This is the last active platform operator. Add another operator first.',
    'Ini operator platform aktif terakhir. Tambahkan operator lain terlebih dahulu.',
  );
}

/** 409 `mail_required`: mail is required on this installation and does not work now (the link is never shown). */
export function mailRequired(reason: string): ConflictError {
  return conflict(
    'mail_required',
    `Mail is required on this installation and ${reason}. Fix mail.smtp first: the link is only sent by email.`,
    `Email wajib pada instalasi ini dan ${reason}. Perbaiki mail.smtp terlebih dahulu: tautan hanya dikirim melalui email.`,
  );
}

/** The major version of the first match of `pattern` in `ua`, or null. */
function major(ua: string, pattern: RegExp): string | null {
  return pattern.exec(ua)?.[1] ?? null;
}

/**
 * The browser and system of a user agent: `Chrome 130, Windows`, `Safari 17, iOS`, `Firefox 131, Linux`; only the
 * part that is known, or null. Edge and Opera carry Chrome's token too, so they are checked first, and iOS and
 * Android before macOS and Linux, whose names their agents also contain.
 */
export function browserOf(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 1000);
  let browser: string | null = null;
  const edge = major(ua, /\bEdg(?:e|A|iOS)?\/(\d+)/);
  const opera = major(ua, /\b(?:OPR|Opera)\/(\d+)/);
  const firefox = major(ua, /\b(?:Firefox|FxiOS)\/(\d+)/);
  const chrome = major(ua, /\b(?:Chrome|CriOS)\/(\d+)/);
  const safari = /\bSafari\//.test(ua) ? major(ua, /\bVersion\/(\d+)/) : null;
  if (edge) browser = `Edge ${edge}`;
  else if (opera) browser = `Opera ${opera}`;
  else if (firefox) browser = `Firefox ${firefox}`;
  else if (chrome) browser = `Chrome ${chrome}`;
  else if (safari) browser = `Safari ${safari}`;
  const system = /\bWindows\b/.test(ua)
    ? 'Windows'
    : /\b(?:iPhone|iPad|iPod)\b/.test(ua)
      ? 'iOS'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\bCrOS\b/.test(ua)
          ? 'ChromeOS'
          : /\b(?:Macintosh|Mac OS X)\b/.test(ua)
            ? 'macOS'
            : /\bLinux\b/.test(ua)
              ? 'Linux'
              : null;
  if (browser && system) return `${browser}, ${system}`;
  return browser ?? system;
}

/**
 * Runs `fn` in one transaction as the database owner with platform scope (the application role only reads
 * `platform.platform_role`). 503 `dependency-unavailable` when the api has no owner connection
 * (`database.migrator_url_file`), as the organisation creation answers.
 */
export async function withOwner<T>(config: MscdConfig, what: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  let connectionString: string;
  try {
    connectionString = config.databaseUrl('migrator');
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new DependencyUnavailableError(`${what} needs the database owner role in the api (database.migrator_url_file)`, { cause: error });
    }
    throw error;
  }
  const owner = createKysely<DB>({ connectionString, max: 1, applicationName: 'mscd-ops-operators' });
  try {
    return await owner.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true), set_config('app.request_id', ${currentRequestId() ?? ''}, true)`.execute(trx);
      return fn(trx);
    });
  } finally {
    await owner.destroy();
  }
}

/**
 * Locks every active platform operator account (`for update` on `platform.app_user`, in id order) and returns their
 * ids. Every decision about the last active operator (disabling an account, removing an operator) takes this lock
 * before it locks the account it changes, so two such decisions always take their locks in the same order: one waits
 * for the other and then sees its outcome (409 `last_operator`), and neither is aborted as a deadlock.
 */
export async function lockActiveOperators(trx: Trx): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select u.id from platform.app_user u
     where u.status = 'active' and u.deleted_at is null
       and exists (select 1 from platform.platform_role r where r.user_id = u.id and r.role = 'platform_operator' and r.revoked_at is null)
     order by u.id
       for update of u`.execute(trx);
  return rows.map((r) => r.id);
}

/** Ends every open session of an account (reason `operator_revoked`) in `trx`; returns how many were open. */
export async function revokeAllSessions(trx: Trx, userId: string, now: Date): Promise<number> {
  const result = await inPlatformScope(trx, () =>
    trx
      .updateTable('platform.session')
      .set({ revoked_at: now, revoke_reason: OPERATOR_REVOKED })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
  return Number(result.numUpdatedRows);
}
