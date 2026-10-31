// Reading a version's file through one's own read confirmation (Milestone 3 D.7 "Confirming"): "Open document" gives
// every person in the audience a short-lived address of the version's file, also a member without file rights in that
// system (Top Management, a Domain Owner who does not own the document), and only for that version. For a file the api
// streams (Managed Vault, pass-through), `me.acknowledgements.open` issues a redirect token that names the person's
// acknowledgement row, and `GET /storage/objects/{id}/content?via=acknowledgement&t=` (files/object-access.service.ts)
// asks this check in place of `storage.object.read` and the scope policy. The classification rule of the scope policy
// still applies: a `restricted` document opens only for its owner and the Management System Managers and Programme
// Owners of a linked system (acknowledgement-visibility.ts), as on every other file route. It is kept beside the rows it
// reads so the rule stays with the read confirmation, and it imports nothing from `files/`, so the file module calls it
// without a module cycle.
//
// The address names a system the person may still read (`ms.read`, which the content route's guard checks with
// `via=acknowledgement`): the system of their task while they hold an asked role there, else the request's, else
// another system the document counts in (a linked system, or every system for an organisation-wide document or an
// organisation-wide audience). A person whose role in the task's system ended but who still holds one in another such
// system stays in the audience (the daily job keeps them asked), so the grant follows the role that keeps them there.
import { ACKNOWLEDGEMENT_ROLES } from '@mscd/shared';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { classificationAllows } from './acknowledgement-visibility';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AcknowledgementFileGrant {
  acknowledgementId: string;
  /**
   * A system of the document where the person holds an asked role (so `ms.read`): the task's first, then the
   * request's, then the others by slug. The address names it, and the content route audits the download in it.
   */
  msId: string;
  documentCode: string;
  versionLabel: string;
}

/**
 * Why there is no grant: `none` when the row is not the person's, is excused, belongs to a closed request without a
 * confirmation, names another file, or its document is hidden from the person by the classification rule; `no_role`
 * when the row would grant the file but the person no longer holds an asked role in any system of the document (the
 * daily job excuses them on its next run).
 */
export type AcknowledgementGrantRefusal = 'none' | 'no_role';

/**
 * The grant of the acknowledgement row `acknowledgementId` to read the storage object `objectId` for `userId`, or the
 * reason there is none: the row is the person's own and not excused, its request is open (a confirmed row may open its
 * version again after the request closed, as `me.acknowledgements.open` allows), the request's version holds the
 * object, the classification rule lets the person see the document (`classificationAllows`: a `restricted` document
 * only for its owner and the managers of a linked system), and the person still holds an asked role in a system of the
 * document (the system the grant names). The caller checks disposed content as every file route does
 * (`assertContentNotDisposed`, D.2).
 */
export async function acknowledgementFileGrantOf(
  trx: Trx,
  userId: string,
  acknowledgementId: string,
  objectId: string,
): Promise<AcknowledgementFileGrant | AcknowledgementGrantRefusal> {
  if (!UUID.test(userId) || !UUID.test(acknowledgementId) || !UUID.test(objectId)) return 'none';
  const { rows } = await sql<{ id: string; ms_id: string | null; doc_code: string; version_label: string }>`
    select a.id, d.doc_code, v.version_label,
           (select m.id from management_system m
             where m.deleted_at is null
               and (m.id = t.management_system_id or m.id = r.management_system_id
                    or (m.status <> 'archived'
                        and (r.audience_scope = 'organisation' or d.is_org_wide
                             or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                          and l.management_system_id = m.id and l.deleted_at is null))))
               and exists (select 1 from user_ms_role ur
                            where ur.user_id = a.user_id and ur.management_system_id = m.id and ur.deleted_at is null
                              and ur.approval_status = 'active' and (ur.valid_until is null or ur.valid_until > now())
                              and ur.role = any(${[...ACKNOWLEDGEMENT_ROLES]}::text[])
                              and (r.audience_scope <> 'roles' or coalesce(cardinality(r.audience_roles), 0) = 0 or ur.role = any(r.audience_roles)))
             order by (m.id = t.management_system_id) desc nulls last, (m.id = r.management_system_id) desc, m.slug
             limit 1) as ms_id
      from acknowledgement a
      join acknowledgement_request r on r.id = a.acknowledgement_request_id and r.deleted_at is null
      join document d on d.id = r.document_id and d.deleted_at is null
      join document_version v on v.id = r.document_version_id and v.deleted_at is null
      join storage_object o on o.id = v.storage_object_id and o.deleted_at is null
      left join lateral (
        select t.management_system_id from task t
         where t.source_rule = 'acknowledgement' and t.entity_type = 'acknowledgement' and t.entity_id = a.id and t.deleted_at is null
         order by t.created_at desc limit 1) t on true
     where a.id = ${acknowledgementId}::uuid and a.user_id = ${userId}::uuid and a.deleted_at is null
       and v.storage_object_id = ${objectId}::uuid
       and (a.status = 'confirmed' or (a.status = 'pending' and r.status = 'open'))
       and ${classificationAllows(sql`${userId}::uuid`, sql.ref('d.id'))}`.execute(trx);
  const row = rows[0];
  if (!row) return 'none';
  if (!row.ms_id) return 'no_role';
  return { acknowledgementId: row.id, msId: row.ms_id, documentCode: row.doc_code, versionLabel: row.version_label };
}

/** `acknowledgementFileGrantOf` for the content route: the grant, or null whatever the reason. */
export async function acknowledgementFileGrant(trx: Trx, userId: string, acknowledgementId: string, objectId: string): Promise<AcknowledgementFileGrant | null> {
  const result = await acknowledgementFileGrantOf(trx, userId, acknowledgementId, objectId);
  return typeof result === 'string' ? null : result;
}
