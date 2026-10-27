// IANA time zones of organisations (D-07, Milestone 2 D.2): a zone is accepted when `Intl` knows it and PostgreSQL
// lists it in `pg_timezone_names`, because local dates are computed in both places. The stored spelling is the one
// `Intl` resolves to (`asia/jakarta` becomes `Asia/Jakarta`).
import { sql } from 'kysely';
import { ValidationError } from '../../common/problems';
import type { Trx } from '../../common/tokens';

/** The canonical spelling of an IANA time zone name, or null when `Intl` does not know it. */
export function canonicalTimeZone(value: string): string | null {
  const name = value.trim();
  if (name === '' || name.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The canonical name of `value` when both `Intl` and the database know it; otherwise 400 `validation` on `path`.
 * Runs in the caller's transaction (any role may read `pg_timezone_names`).
 */
export async function checkedTimeZone(trx: Trx, value: string, path = 'body.timeZone'): Promise<string> {
  const canonical = canonicalTimeZone(value);
  const refuse = () => new ValidationError([{ path, message: `Unknown time zone ${JSON.stringify(value)}; use an IANA name such as Asia/Jakarta` }]);
  if (!canonical) throw refuse();
  const { rows } = await sql<{ found: boolean }>`select exists (select 1 from pg_timezone_names where name = ${canonical}) as found`.execute(trx);
  if (!rows[0]?.found) throw refuse();
  return canonical;
}
