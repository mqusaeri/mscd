// The classification rule on the read confirmation path (build plan F.7 "Classification", D-04): a document classified
// `restricted` is visible only to its owner and to the Management System Managers and Programme Owners of a system it
// is linked to. The scope policy applies that rule on every read path (`recordVisible`, `canReadObjectIn`); the read
// confirmation grants a version's file to its audience in place of the file permission and the owner scope (D.7), so
// it applies the same rule itself:
// - `audienceOf` never asks a person who may not see the document (their list, tasks and notifications never name it);
// - `acknowledgementFileGrant` refuses such a person, so an address issued before the document became restricted, or
//   before its owner changed, no longer opens it;
// - `me.acknowledgements` leaves their rows of such a document out, and `documents.update`
//   (`excuseHiddenByClassification`) and the daily job excuse them.
// An organisation-wide document counts the systems it is linked to, as the file routes do (`canReadObjectIn`).
import { sql, type RawBuilder } from 'kysely';

/** The business roles that see every `restricted` document of a system they hold them in. */
export const RESTRICTED_READER_ROLES = ['ms_manager', 'programme_owner'] as const;

/**
 * SQL condition: the person `user` may see the document `document` under the classification rule: it is not
 * `restricted`, or they own it, or they hold an active Management System Manager or Programme Owner role in a system it
 * is linked to. Both arguments are SQL expressions (a column with `sql.ref`, or a bound value cast to `uuid`).
 */
export function classificationAllows(user: RawBuilder<unknown>, document: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`exists (
    select 1 from document cd
     where cd.id = ${document}
       and (cd.classification is distinct from 'restricted'
            or cd.owner_user_id = ${user}
            or exists (select 1 from user_ms_role cr
                         join entity_ms_link cl on cl.entity_type = 'document' and cl.entity_id = cd.id
                          and cl.management_system_id = cr.management_system_id and cl.deleted_at is null
                        where cr.user_id = ${user} and cr.role = any(${[...RESTRICTED_READER_ROLES]}::text[])
                          and cr.approval_status = 'active' and cr.deleted_at is null
                          and (cr.valid_until is null or cr.valid_until > now()))))`;
}
