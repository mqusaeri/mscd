// Reading a version's file through one's own read confirmation (Milestone 3 D.7 "Confirming"): "Open document" gives
// every person in the audience a short-lived address of the version's file, also a member without file rights in that
// system (Top Management, a Domain Owner who does not own the document), and only for that version. For a file the api
// streams (Managed Vault, pass-through) this needs the file routes of `files/` to accept a redirect token that names
// the person's acknowledgement row (see "Follow-ups" in docs/platform/handoff/M3-05.md); this function is the check
// such a token asks, kept beside the rows it reads so the rule stays with the read confirmation. It imports nothing
// from `files/`, so the file module can call it without a module cycle.
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AcknowledgementFileGrant {
  acknowledgementId: string;
  /** The system of the person's task, else the request's: the system the open is audited in. */
  msId: string;
  documentCode: string;
  versionLabel: string;
}

/**
 * The grant of the acknowledgement row `acknowledgementId` to read the storage object `objectId` for `userId`, or null
 * when there is none: the row is the person's own and not excused, its request is open (a confirmed row may open its
 * version again after the request closed, as `me.acknowledgements.open` allows), and the request's version holds the
 * object. The caller checks disposed content as every file route does (`assertContentNotDisposed`, D.2).
 */
export async function acknowledgementFileGrant(trx: Trx, userId: string, acknowledgementId: string, objectId: string): Promise<AcknowledgementFileGrant | null> {
  if (!UUID.test(userId) || !UUID.test(acknowledgementId) || !UUID.test(objectId)) return null;
  const { rows } = await sql<{ id: string; ms_id: string; doc_code: string; version_label: string }>`
    select a.id, coalesce(t.management_system_id, r.management_system_id) as ms_id, d.doc_code, v.version_label
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
       and (a.status = 'confirmed' or (a.status = 'pending' and r.status = 'open'))`.execute(trx);
  const row = rows[0];
  return row ? { acknowledgementId: row.id, msId: row.ms_id, documentCode: row.doc_code, versionLabel: row.version_label } : null;
}
