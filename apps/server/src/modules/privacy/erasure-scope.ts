// Which audit entries an erasure changes, and how (Milestone 3 D.6.5, M3-13 after security review 1 and ISO M3).
//
// The person's values are the email and the handle of the account (values the system controls) and the name as the
// request recorded it (`privacy_request.subject_name`; the erasure refuses to run when the account's display name now
// differs from it). The entries of a chain fall into two sets, each redacted under its own attestation:
//   (a) entries where the person acted, entries about the account, the membership or the person's business roles
//       (`user_ms_role`), and every entry of a record that a manager edited for this request: the record has an entry
//       after the request was received whose before value holds the name as a whole word and whose after value no
//       longer does. In these entries the email, the handle and the name become the pseudonym;
//   (b) every other entry that holds the email or the handle: only those two become the pseudonym, so a name that is
//       also an ordinary word or another record's code ("approved", "POL-001") stays where it is not about the person.
// A person without an account has no actor or account entries: set (a) holds the records the managers edited, with
// the name and the email; set (b) the other entries that hold the email.
//
// Matching is the one of `platform.redact_audit_rows` (`platform.audit_redact_text`: whole words, any case, values of 3
// characters or more). A cheap text search on the stored row comes first, so the exact check runs only on the rows that
// can hold a value.
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../../common/tokens';
import { itemFactsById } from '../retention/retention-items';
import { RECORD_CLASSES } from '../retention/retention-model';
import { inPlatformScope } from '../identity/platform-scope';

/** The person an erasure removes, as the audit entries may name them. */
export interface ErasureSubject {
  /** The account of a member; null for a person without an account. */
  userId: string | null;
  email: string | null;
  handle: string | null;
  /** The name as the request recorded it. */
  name: string | null;
  /** When the request was received: an edit after it counts as an edit for the request. */
  since: Date;
}

/** The entries of one chain an erasure redacts. */
export interface RedactionSets {
  /** Set (a): email, handle and name are replaced. */
  full: string[];
  /** Set (b): only the email and the handle are replaced. */
  partial: string[];
  /** Entries of both sets that the redaction changes (the impact shown before erasing). */
  changing: number;
}

/** The chain of the organisation (`audit_trail` of the transaction's schema) or this organisation's platform entries. */
export type ErasureChain = { kind: 'tenant' } | { kind: 'platform'; orgId: string };

/** Placeholder pseudonym for the change checks (any text works; it is never written). */
const PROBE = 'Former user 0000';

const usable = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length >= 3 ? trimmed : null;
};

/** Values of set (a): every personal value of the person. */
export function fullValues(subject: Pick<ErasureSubject, 'email' | 'handle' | 'name'>, pseudonym: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of [subject.email, subject.handle, subject.name]) {
    const v = usable(value);
    if (v) out[v] = pseudonym;
  }
  return out;
}

/** Values of set (b): the email and the handle only. */
export function partialValues(subject: Pick<ErasureSubject, 'email' | 'handle'>, pseudonym: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of [subject.email, subject.handle]) {
    const v = usable(value);
    if (v) out[v] = pseudonym;
  }
  return out;
}

/**
 * True for a value that the JSON text of a row shows as it is (no quote, backslash or control character, which JSON
 * escapes), so a plain text search on `before_data::text` can find it.
 */
function searchable(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/["\\\u0000-\u001f\u007f]/.test(value);
}

/** SQL that is true when the row's stored text may hold one of the values (false without values). */
function mayHold(text: RawBuilder<string>, values: readonly string[]): RawBuilder<boolean> {
  if (values.length === 0) return sql<boolean>`false`;
  if (!values.every(searchable)) return sql<boolean>`true`;
  return sql<boolean>`(${sql.join(values.map((v) => sql`strpos(lower(${text}), lower(${v})) > 0`), sql` or `)})`;
}

/** SQL that is true when replacing `values` changes the entry's code, before or after value. */
function changes(values: Record<string, string>): RawBuilder<boolean> {
  if (Object.keys(values).length === 0) return sql<boolean>`false`;
  const json = JSON.stringify(values);
  return sql<boolean>`(platform.audit_redact_text(t.entity_code, ${json}::jsonb) is distinct from t.entity_code
                       or platform.audit_redact_json(t.before_data, ${json}::jsonb) is distinct from t.before_data
                       or platform.audit_redact_json(t.after_data, ${json}::jsonb) is distinct from t.after_data)`;
}

/**
 * The entries of a chain in set (a) and set (b) for the person, oldest first. A platform chain is read with platform
 * scope (switched on for the statement); a tenant chain in the caller's organisation.
 */
export async function redactionSets(trx: Trx, chain: ErasureChain, subject: ErasureSubject): Promise<RedactionSets> {
  const run = async (): Promise<RedactionSets> => {
    const table = chain.kind === 'tenant' ? sql`audit_trail` : sql`platform.audit_log`;
    const inChain = chain.kind === 'tenant' ? sql<boolean>`true` : sql<boolean>`t.organization_id = ${chain.orgId}::uuid`;
    const full = fullValues(subject, PROBE);
    const partial = partialValues(subject, PROBE);
    const name = usable(subject.name);
    const rowText = sql<string>`(coalesce(t.entity_code, '') || chr(10) || coalesce(t.before_data::text, '') || chr(10) || coalesce(t.after_data::text, ''))`;
    const nameOnly = name ? JSON.stringify({ [name]: PROBE }) : null;
    // Records a manager edited for the request: an entry after the request whose before value holds the name and whose
    // after value no longer does.
    const edited = nameOnly
      ? sql`select distinct t.entity_type, t.entity_id from ${table} t
             where ${inChain} and t.entity_id is not null and t.entity_type is not null and t.occurred_at >= ${subject.since}
               and ${mayHold(sql<string>`coalesce(t.before_data::text, '')`, [name!])}
               and platform.audit_redact_json(t.before_data, ${nameOnly}::jsonb) is distinct from t.before_data
               and platform.audit_redact_json(t.after_data, ${nameOnly}::jsonb) is not distinct from t.after_data`
      : sql`select null::varchar as entity_type, null::uuid as entity_id where false`;
    // The person's own entries: where they acted, and about the account, the membership or their business roles (the
    // `user_ms_role` rows of the organisation, as the personal data copy lists them).
    const roles = chain.kind === 'tenant'
      ? sql<boolean>`(t.entity_type = 'user_ms_role' and t.entity_id in (select r.id from user_ms_role r where r.user_id = ${subject.userId}::uuid))`
      : sql<boolean>`false`;
    const own = subject.userId
      ? sql<boolean>`(t.actor_user_id = ${subject.userId}::uuid
                      or (t.entity_id = ${subject.userId}::uuid and t.entity_type in ('user', 'org_membership'))
                      or ${roles})`
      : sql<boolean>`false`;
    const inFull = sql<boolean>`(${own} or (t.entity_type, t.entity_id) in (select e.entity_type, e.entity_id from edited e))`;
    const { rows } = await sql<{ seq: string; full: boolean; changing: boolean }>`
      with edited as (${edited})
      select t.seq::text as seq, ${inFull} as full,
             case when ${inFull} then (t.source_ip is not null or t.user_agent is not null or ${changes(full)}) else true end as changing
        from ${table} t
       where ${inChain}
         and (${inFull} or (${mayHold(rowText, Object.keys(partial))} and ${changes(partial)}))
       order by t.seq`.execute(trx);
    return {
      full: rows.filter((r) => r.full).map((r) => r.seq),
      partial: rows.filter((r) => !r.full).map((r) => r.seq),
      changing: rows.filter((r) => r.changing).length,
    };
  };
  return chain.kind === 'platform' ? inPlatformScope(trx, run) : run();
}

/**
 * Legal holds in force on records about the person or that the person owns (shown before erasing, ISO o9): holds on
 * competence records about the person or owned by them, and on the items of the other retention classes the person
 * owns (the owner of `retention-items.ts`). The erasure still runs (H.12); the records stay under the pseudonym.
 */
export async function legalHoldsAbout(trx: Trx, userId: string, ctx: { timeZone: string; today: string }): Promise<number> {
  const holds = await trx
    .selectFrom('retention_hold')
    .select(['record_class', 'item_id'])
    .where('released_at', 'is', null)
    .where('deleted_at', 'is', null)
    .execute();
  if (holds.length === 0) return 0;
  let count = 0;
  const competence = holds.filter((h) => h.record_class === 'competence_record').map((h) => h.item_id);
  if (competence.length > 0) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from competence_record c
       where c.id = any(${competence}::uuid[]) and (c.user_id = ${userId}::uuid or c.owner_user_id = ${userId}::uuid)`.execute(trx);
    count += rows[0]?.n ?? 0;
  }
  for (const recordClass of RECORD_CLASSES) {
    if (recordClass === 'competence_record') continue;
    const ids = holds.filter((h) => h.record_class === recordClass).map((h) => h.item_id);
    if (ids.length === 0) continue;
    for (const facts of (await itemFactsById(trx, recordClass, ids, ctx)).values()) {
      if (facts.ownerUserId === userId) count += 1;
    }
  }
  return count;
}

/** The facts of a request an erasure needs. */
export interface ErasureRequestFacts {
  subject_kind: 'member' | 'other';
  subject_user_id: string | null;
  subject_name: string | null;
  subject_email: string | null;
  received_at: Date;
}

/**
 * The person of a request as the audit entries may name them: for a member the account's email and handle and the
 * name the request recorded (the account's display name when the request has none), for a person without an account
 * the name and email the request recorded. Null when the member's account no longer exists.
 */
export async function subjectOfRequest(trx: Trx, row: ErasureRequestFacts, nameFallback?: string | null): Promise<ErasureSubject | null> {
  if (row.subject_kind === 'member' && row.subject_user_id) {
    const account = await trx
      .selectFrom('platform.app_user')
      .select(['email', 'handle', 'display_name'])
      .where('id', '=', row.subject_user_id)
      .executeTakeFirst();
    if (!account) return null;
    return {
      userId: row.subject_user_id,
      email: account.email,
      handle: account.handle,
      name: row.subject_name ?? nameFallback ?? account.display_name,
      since: new Date(row.received_at),
    };
  }
  return { userId: null, email: row.subject_email, handle: null, name: row.subject_name, since: new Date(row.received_at) };
}

/** What an erasure will change, shown in the erase dialog (`erasureImpact` of `privacy-requests.get`). */
export interface ErasureImpact {
  tenantEntries: number;
  platformEntries: number;
  legalHolds: number;
}

/**
 * The impact of erasing the person of a request now: the entries of the organisation's audit trail and of the platform
 * audit log (this organisation's entries) that the redaction changes, and the legal holds on records about the person.
 */
export async function erasureImpact(trx: Trx, org: { id: string; timeZone: string }, row: ErasureRequestFacts, today: string): Promise<ErasureImpact> {
  const subject = await subjectOfRequest(trx, row);
  if (!subject) return { tenantEntries: 0, platformEntries: 0, legalHolds: 0 };
  const tenant = await redactionSets(trx, { kind: 'tenant' }, subject);
  const platform = subject.userId ? await redactionSets(trx, { kind: 'platform', orgId: org.id }, subject) : null;
  const legalHolds = subject.userId ? await legalHoldsAbout(trx, subject.userId, { timeZone: org.timeZone, today }) : 0;
  return { tenantEntries: tenant.changing, platformEntries: platform?.changing ?? 0, legalHolds };
}
