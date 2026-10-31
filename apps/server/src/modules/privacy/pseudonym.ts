// How the organisation names a person it erased (Milestone 3 D.6.5): by the pseudonym of `erased_person` ("Former
// user 7F3A") as display name, and by its handle form (`former-user-7f3a`) wherever a handle is expected, since
// `PersonId` allows no spaces. Every query that names a person from `platform.app_user` for an organisation goes
// through these helpers, so an erased person never shows with the name, handle or email of the account (which may
// still be in use in another organisation). The helpers run in a tenant transaction: `erased_person` lives in the
// organisation's schema.
//
// SQL forms, for a query that joins `platform.app_user u`:
//   ${erasedJoin('ep', 'u.id')}            left join erased_person ep on ep.erased_user_id = u.id and ep.deleted_at is null
//   ${shownHandle('u', 'ep')}              coalesce(lower(replace(ep.pseudonym, ' ', '-')), u.handle)
//   ${shownName('u', 'ep')}                coalesce(ep.pseudonym, u.display_name)
//   ${erasedValue('ep', sql`u.email`)}     null for an erased person, else the value (an email, a job title)
// and for a single person column, a scalar subquery:
//   ${handleOfUser('t.owner_user_id')}     the shown handle of the user in that column, null when the column is null
//   ${nameOfUser('t.owner_user_id')}       the shown name
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../common/tokens';

/** The job title shown for a person erased in this organisation. */
export const ERASED_JOB_TITLE = 'Former member';

/**
 * The handle form of a pseudonym ("Former user 7F3A" gives `former-user-7f3a`): a valid handle (`PersonId`), so the
 * snapshots and the lists that carry handles can name an erased person. The SQL form is `shownHandle`.
 */
export function pseudonymHandle(pseudonym: string): string {
  return pseudonym.toLowerCase().replace(/ /g, '-');
}

/** `left join erased_person <alias>` on the user id column, live rows only. */
export function erasedJoin(alias: string, userIdColumn: string): RawBuilder<unknown> {
  return sql`left join erased_person ${sql.id(alias)} on ${sql.ref(`${alias}.erased_user_id`)} = ${sql.ref(userIdColumn)} and ${sql.ref(`${alias}.deleted_at`)} is null`;
}

/** The handle shown for the joined account `userAlias`: the handle form of the pseudonym of `erasedAlias`, else the account's handle. */
export function shownHandle(userAlias: string, erasedAlias: string): RawBuilder<string | null> {
  return sql<string | null>`coalesce(lower(replace(${sql.ref(`${erasedAlias}.pseudonym`)}, ' ', '-')), ${sql.ref(`${userAlias}.handle`)})`;
}

/** The name shown for the joined account `userAlias`: the pseudonym of `erasedAlias`, else the account's display name. */
export function shownName(userAlias: string, erasedAlias: string): RawBuilder<string | null> {
  return sql<string | null>`coalesce(${sql.ref(`${erasedAlias}.pseudonym`)}, ${sql.ref(`${userAlias}.display_name`)})`;
}

/** A value of the account that an erased person no longer shows (email, job title): null after the erasure. */
export function erasedValue<T>(erasedAlias: string, value: RawBuilder<T>): RawBuilder<T | null> {
  return sql<T | null>`(case when ${sql.ref(`${erasedAlias}.pseudonym`)} is null then ${value} end)`;
}

function columnOf(userId: string | RawBuilder<unknown>): RawBuilder<unknown> {
  return typeof userId === 'string' ? sql.ref(userId) : userId;
}

/** The shown handle of the user in a person column (a scalar subquery; null for an empty column). */
export function handleOfUser(userId: string | RawBuilder<unknown>): RawBuilder<string | null> {
  return sql<string | null>`(select coalesce(lower(replace(pn_e.pseudonym, ' ', '-')), pn_u.handle) from platform.app_user pn_u
    left join erased_person pn_e on pn_e.erased_user_id = pn_u.id and pn_e.deleted_at is null where pn_u.id = ${columnOf(userId)})`;
}

/** The shown name of the user in a person column (a scalar subquery; null for an empty column). */
export function nameOfUser(userId: string | RawBuilder<unknown>): RawBuilder<string | null> {
  return sql<string | null>`(select coalesce(pn_e.pseudonym, pn_u.display_name) from platform.app_user pn_u
    left join erased_person pn_e on pn_e.erased_user_id = pn_u.id and pn_e.deleted_at is null where pn_u.id = ${columnOf(userId)})`;
}

/** A person erased in this organisation as the lists of people name them. */
export interface ErasedPersonName {
  userId: string;
  handle: string;
  displayName: string;
  jobTitle: string;
}

/**
 * The people erased in this organisation, by pseudonym: a list of people that names members by handle adds these, so
 * a record that names the handle form of a pseudonym shows the pseudonym.
 */
export async function erasedPeople(trx: Trx): Promise<ErasedPersonName[]> {
  const rows = await trx.selectFrom('erased_person').select(['erased_user_id', 'pseudonym']).where('deleted_at', 'is', null).orderBy('pseudonym').execute();
  return rows.map((r) => ({ userId: r.erased_user_id, handle: pseudonymHandle(r.pseudonym), displayName: r.pseudonym, jobTitle: ERASED_JOB_TITLE }));
}
