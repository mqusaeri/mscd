// The items of each record class of retention (Milestone 3 D.8, M3-06): one query per class that gives, for the items
// of the organisation, the business code and title the screens show, the home system (the system whose Management
// System Managers review it), the document type (document versions), the start of the retention period when the item
// qualifies now, whether it is current (RET-CURRENT), its owner, and the storage objects a disposal acts on.
//
// Each query runs in two modes: `discover` lists the items that may be due (the daily `retention.review` job), and
// `ids` reads given items whatever their state (holds, decisions, approvals and the lists). The start of the period
// is null when the item does not qualify now: a document version that is not superseded, the current file of an
// evidence item, an open finding, a competence record that has not lapsed.
//
// Period starts (D.8): a superseded document version, the approval date of the version that replaced it; an evidence
// file, the date it was replaced (`storage_object.replaced_at`) or its evidence item was marked deleted; an evidence
// pack, its build date; an audit event, its last day; a finding, its closing date; a corrective action, its
// verification date; a management review, its closing date; a competence record, `valid_until` or its deletion date.
// Instants are read as local dates in the organisation's time zone.
import type { RetentionRecordClass } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { ConflictError, NotFoundError } from '../../common/problems';
import type { Trx } from '../../common/tokens';

/** What the retention routes and the job know of one item. */
export interface ItemFacts {
  recordClass: RetentionRecordClass;
  itemId: string;
  /** Business code: `ISP-001 v1.0`, `EV-0313 v2`, `PACK-1A2B3C4D`, the event's short label, `NC-2025-01`, `CMP-1A2B3C4D`. */
  code: string;
  title: string | null;
  /** The system whose managers review the item (its own system, or the primary system of a shared record). */
  msId: string | null;
  docType: string | null;
  /** Start of the retention period, or null when the item does not qualify now. */
  startsOn: string | null;
  /** A document's current or unapproved version, or the current file of an evidence item (RET-CURRENT). */
  current: boolean;
  ownerUserId: string | null;
  /** Storage objects whose content a disposal removes (or whose owner is asked to delete the file). */
  objectIds: string[];
  /** The record is already marked deleted (records only). */
  recordDeleted: boolean;
}

interface ItemRow {
  item_id: string;
  code: string;
  title: string | null;
  ms_id: string | null;
  doc_type: string | null;
  starts_on: string | null;
  current: boolean;
  owner_user_id: string | null;
  object_ids: string[] | null;
  record_deleted: boolean;
}

/** How a class query selects its items: the candidates of the daily review, or given ids. */
export type ItemMode = { kind: 'discover' } | { kind: 'ids'; ids: readonly string[] };

interface QueryContext {
  /** IANA time zone of the organisation (instants become local dates). */
  timeZone: string;
  /** The organisation's today (competence records lapse after `valid_until`). */
  today: string;
}

const EVIDENCE_FILE_ACTIONS = sql`('evidence.file_uploaded', 'evidence.file_linked')`;

/**
 * The home system of a shared record: its primary live link, else any link; `fallback` the first system (documents).
 * An evidence item without a link falls back to the system of its first target (in its query).
 */
function homeOf(entityType: string, id: RawBuilder<unknown>, fallback: boolean): RawBuilder<string | null> {
  const linked = sql<string | null>`(select l.management_system_id from entity_ms_link l
      join management_system m on m.id = l.management_system_id and m.deleted_at is null
     where l.entity_type = ${entityType} and l.entity_id = ${id}
     order by (l.deleted_at is null) desc, l.is_primary desc, l.created_at, l.id limit 1)`;
  if (!fallback) return linked;
  return sql<string | null>`coalesce(${linked}, (select m.id from management_system m where m.deleted_at is null order by m.position, m.slug limit 1))`;
}

const idsOf = (mode: ItemMode) => (mode.kind === 'ids' ? [...mode.ids] : []);

/** One query per record class. */
const CLASS_QUERIES: Readonly<Record<RetentionRecordClass, (mode: ItemMode, ctx: QueryContext) => RawBuilder<ItemRow>>> = {
  document_version: (mode, ctx) => sql<ItemRow>`
    select v.id as item_id,
           left(d.doc_code || ' v' || v.version_label, 60) as code,
           left(d.title, 300) as title,
           ${homeOf('document', sql.ref('d.id'), true)} as ms_id,
           d.doc_type,
           case when v.status = 'superseded' and v.deleted_at is null and d.current_version_id is distinct from v.id then
             coalesce((select min(n.approved_at) from document_version n
                        where n.document_id = v.document_id and n.deleted_at is null and n.approved_at is not null
                          and n.id <> v.id and n.created_at > v.created_at),
                      (v.updated_at at time zone ${ctx.timeZone})::date)
           end as starts_on,
           (v.status <> 'superseded' or d.current_version_id is not distinct from v.id) as current,
           d.owner_user_id,
           case when o.content_disposed_at is null then array[o.id] else array[]::uuid[] end as object_ids,
           false as record_deleted
      from document_version v
      join document d on d.id = v.document_id
      join storage_object o on o.id = v.storage_object_id
     where ${mode.kind === 'discover'
       ? sql`v.status = 'superseded' and v.deleted_at is null and o.content_disposed_at is null and d.current_version_id is distinct from v.id`
       : sql`v.id = any(${idsOf(mode)}::uuid[])`}`,

  // An earlier file belongs to the evidence item whose file it was: the current file of an item, else the evidence
  // item of the latest `evidence.file_uploaded` or `evidence.file_linked` entry that replaced it (`before.storageObjectId`).
  evidence_file: (mode, ctx) => sql<ItemRow>`
    with src as (
      select e.storage_object_id as object_id, e.id as evidence_id, 0 as prio, 0::bigint as seq from evidence e
       where e.storage_object_id is not null
         and ${mode.kind === 'discover' ? sql`e.deleted_at is not null` : sql`e.storage_object_id = any(${idsOf(mode)}::uuid[])`}
      union all
      select nullif(a.before_data->>'storageObjectId', '')::uuid, a.entity_id, 1, a.seq from audit_trail a
       where a.action in ${EVIDENCE_FILE_ACTIONS} and a.entity_type = 'evidence' and a.entity_id is not null
         and nullif(a.before_data->>'storageObjectId', '') is not null
         ${mode.kind === 'ids' ? sql`and nullif(a.before_data->>'storageObjectId', '')::uuid = any(${idsOf(mode)}::uuid[])` : sql``}
    ), pick as (
      select distinct on (object_id) object_id, evidence_id from src order by object_id, prio, seq desc
    )
    select o.id as item_id,
           left(e.evidence_code || ' ' || coalesce(o.version_label, 'file'), 60) as code,
           left(e.title, 300) as title,
           coalesce(${homeOf('evidence', sql.ref('e.id'), false)},
                    (select t.management_system_id from evidence_target t join management_system m on m.id = t.management_system_id and m.deleted_at is null
                      where t.evidence_id = e.id order by (t.deleted_at is null) desc, t.position, t.created_at limit 1)) as ms_id,
           null::varchar as doc_type,
           case when live.id is not null or o.deleted_at is not null then null
                when o.replaced_at is not null then (o.replaced_at at time zone ${ctx.timeZone})::date
                when e.deleted_at is not null and e.storage_object_id = o.id then (e.deleted_at at time zone ${ctx.timeZone})::date
           end as starts_on,
           (live.id is not null) as current,
           e.owner_user_id,
           case when o.content_disposed_at is null then array[o.id] else array[]::uuid[] end as object_ids,
           false as record_deleted
      from pick
      join storage_object o on o.id = pick.object_id
      join evidence e on e.id = pick.evidence_id
      left join lateral (select c.id from evidence c where c.storage_object_id = o.id and c.deleted_at is null limit 1) live on true
     where ${mode.kind === 'discover'
       ? sql`o.content_disposed_at is null and o.deleted_at is null and (o.replaced_at is not null or e.deleted_at is not null)`
       : sql`true`}`,

  evidence_pack: (mode, ctx) => sql<ItemRow>`
    select p.id as item_id,
           'PACK-' || upper(substr(replace(p.id::text, '-', ''), 1, 8)) as code,
           left(coalesce(nullif(p.pack_folder, ''), 'Evidence pack'), 300) as title,
           p.management_system_id as ms_id,
           null::varchar as doc_type,
           case when p.status = 'ready' and p.built_at is not null and p.deleted_at is null then (p.built_at at time zone ${ctx.timeZone})::date end as starts_on,
           false as current,
           p.created_by as owner_user_id,
           array(select x.id from storage_object x
                  where x.content_disposed_at is null and x.deleted_at is null
                    and (x.id in (p.archive_object_id, p.manifest_pdf_object_id, p.manifest_csv_object_id)
                         or x.id in (select i.copy_storage_object_id from evidence_pack_item i where i.evidence_pack_id = p.id))
                  order by x.id) as object_ids,
           false as record_deleted
      from evidence_pack p
     where ${mode.kind === 'discover'
       ? sql`p.status = 'ready' and p.built_at is not null and p.deleted_at is null`
       : sql`p.id = any(${idsOf(mode)}::uuid[])`}`,

  audit_event: (mode) => sql<ItemRow>`
    select a.id as item_id, left(a.short_label, 60) as code, left(a.name_en, 300) as title, a.management_system_id as ms_id,
           null::varchar as doc_type,
           case when a.outcome is not null and a.deleted_at is null then (a.scheduled_at + (coalesce(a.audit_days, 1) - 1))::date end as starts_on,
           false as current, null::uuid as owner_user_id, array[]::uuid[] as object_ids, a.deleted_at is not null as record_deleted
      from audit_event a
     where ${mode.kind === 'discover' ? sql`a.outcome is not null and a.deleted_at is null` : sql`a.id = any(${idsOf(mode)}::uuid[])`}`,

  finding: (mode) => sql<ItemRow>`
    select f.id as item_id, left(f.code, 60) as code, left(f.title, 300) as title, f.management_system_id as ms_id, null::varchar as doc_type,
           case when f.status = 'closed' and f.deleted_at is null then f.closed_at end as starts_on,
           false as current, f.owner_user_id, array[]::uuid[] as object_ids, f.deleted_at is not null as record_deleted
      from finding f
     where ${mode.kind === 'discover' ? sql`f.status = 'closed' and f.deleted_at is null and f.closed_at is not null` : sql`f.id = any(${idsOf(mode)}::uuid[])`}`,

  corrective_action: (mode, ctx) => sql<ItemRow>`
    select c.id as item_id, left(c.code, 60) as code, left(c.title, 300) as title, c.management_system_id as ms_id, null::varchar as doc_type,
           case when c.status = 'closed' and c.deleted_at is null then coalesce(c.verified_at, (c.updated_at at time zone ${ctx.timeZone})::date) end as starts_on,
           false as current, c.owner_user_id, array[]::uuid[] as object_ids, c.deleted_at is not null as record_deleted
      from corrective_action c
     where ${mode.kind === 'discover' ? sql`c.status = 'closed' and c.deleted_at is null` : sql`c.id = any(${idsOf(mode)}::uuid[])`}`,

  management_review: (mode) => sql<ItemRow>`
    select r.id as item_id, left(r.code, 60) as code, left(r.title, 300) as title, ${homeOf('management_review', sql.ref('r.id'), false)} as ms_id,
           null::varchar as doc_type,
           case when r.status = 'closed' and r.deleted_at is null then r.closed_at end as starts_on,
           false as current, r.owner_user_id, array[]::uuid[] as object_ids, r.deleted_at is not null as record_deleted
      from management_review r
     where ${mode.kind === 'discover' ? sql`r.status = 'closed' and r.deleted_at is null and r.closed_at is not null` : sql`r.id = any(${idsOf(mode)}::uuid[])`}`,

  // The record names a person, so the title is the role only (no name is copied into a review).
  competence_record: (mode, ctx) => sql<ItemRow>`
    select c.id as item_id, 'CMP-' || upper(substr(replace(c.id::text, '-', ''), 1, 8)) as code, left(c.role_title, 300) as title,
           ${homeOf('competence_record', sql.ref('c.id'), false)} as ms_id, null::varchar as doc_type,
           case when c.deleted_at is not null and proof.id is not null then (c.deleted_at at time zone ${ctx.timeZone})::date
                when c.deleted_at is null and c.valid_until < ${ctx.today}::date then c.valid_until
           end as starts_on,
           false as current, c.owner_user_id,
           case when proof.id is not null then array[proof.id] else array[]::uuid[] end as object_ids,
           c.deleted_at is not null as record_deleted
      from competence_record c
      left join storage_object proof on proof.id = c.storage_object_id and proof.content_disposed_at is null and proof.deleted_at is null
     where ${mode.kind === 'discover'
       ? sql`((c.deleted_at is null and c.valid_until < ${ctx.today}::date) or (c.deleted_at is not null and proof.id is not null))`
       : sql`c.id = any(${idsOf(mode)}::uuid[])`}`,
};

function factsOf(recordClass: RetentionRecordClass, row: ItemRow): ItemFacts {
  return {
    recordClass,
    itemId: row.item_id,
    code: row.code,
    title: row.title,
    msId: row.ms_id,
    docType: row.doc_type,
    startsOn: row.starts_on,
    current: row.current,
    ownerUserId: row.owner_user_id,
    objectIds: row.object_ids ?? [],
    recordDeleted: row.record_deleted,
  };
}

/** The items of a class that may be due (with a period start), or the given items whatever their state. */
export async function itemsOf(trx: Trx, recordClass: RetentionRecordClass, mode: ItemMode, ctx: QueryContext): Promise<ItemFacts[]> {
  if (mode.kind === 'ids' && mode.ids.length === 0) return [];
  const { rows } = await CLASS_QUERIES[recordClass](mode, ctx).execute(trx);
  const items = rows.map((r) => factsOf(recordClass, r));
  return mode.kind === 'discover' ? items.filter((i) => i.startsOn !== null && i.msId !== null) : items;
}

/** The facts of given items of one class, by id. */
export async function itemFactsById(trx: Trx, recordClass: RetentionRecordClass, ids: readonly string[], ctx: QueryContext): Promise<Map<string, ItemFacts>> {
  const unique = [...new Set(ids)];
  const items = await itemsOf(trx, recordClass, { kind: 'ids', ids: unique }, ctx);
  return new Map(items.map((i) => [i.itemId, i]));
}

/**
 * The id of the item of a class with a business code in a system (the hold form names an item by its code). 404 when
 * none matches; 409 when an audit event's short label names several events.
 */
export async function itemIdByCode(trx: Trx, recordClass: RetentionRecordClass, msId: string, rawCode: string): Promise<string> {
  const code = rawCode.trim();
  let rows: { id: string }[] = [];
  switch (recordClass) {
    case 'document_version': {
      const m = /^(.+?)\s+v(\S+)$/i.exec(code);
      if (m) {
        rows = (await sql<{ id: string }>`
          select v.id from document_version v join document d on d.id = v.document_id
           where d.doc_code = ${m[1]!} and v.version_label = ${m[2]!} and v.deleted_at is null
           order by (d.deleted_at is null) desc, v.created_at desc limit 1`.execute(trx)).rows;
      }
      break;
    }
    case 'evidence_file': {
      const m = /^(.+?)\s+(\S+)$/.exec(code);
      if (m) {
        rows = (await sql<{ id: string }>`
          select o.id from evidence e join storage_object o on o.version_label = ${m[2]!}
             and (o.id = e.storage_object_id or exists (select 1 from audit_trail a
                    where a.entity_type = 'evidence' and a.entity_id = e.id and a.action in ${EVIDENCE_FILE_ACTIONS}
                      and nullif(a.before_data->>'storageObjectId', '')::uuid = o.id))
           where e.evidence_code = ${m[1]!}
           order by (e.deleted_at is null) desc, o.created_at desc limit 1`.execute(trx)).rows;
      }
      break;
    }
    case 'evidence_pack':
    case 'competence_record': {
      const prefix = recordClass === 'evidence_pack' ? 'PACK' : 'CMP';
      const m = new RegExp(`^${prefix}-([0-9A-F]{8})$`, 'i').exec(code);
      if (m) {
        const table = recordClass === 'evidence_pack' ? 'evidence_pack' : 'competence_record';
        rows = (await sql<{ id: string }>`
          select id from ${sql.table(table)} where replace(id::text, '-', '') like ${`${m[1]!.toLowerCase()}%`} order by created_at limit 2`.execute(trx)).rows;
      }
      break;
    }
    case 'audit_event':
      rows = (await sql<{ id: string }>`
        select id from audit_event where management_system_id = ${msId} and short_label = ${code} and deleted_at is null order by scheduled_at desc limit 2`.execute(trx)).rows;
      if (rows.length > 1) {
        throw new ConflictError(`Several audit events of this system are named ${code}`, {
          messageKey: 'retention.ambiguous_code',
          messages: {
            en: `Several audit events of this system are named ${code}. Place the hold from the review list instead.`,
            id: `Beberapa peristiwa audit sistem ini bernama ${code}. Tempatkan penahanan dari daftar tinjauan.`,
          },
        });
      }
      break;
    case 'finding':
    case 'corrective_action':
      rows = (await sql<{ id: string }>`
        select id from ${sql.table(recordClass)} where management_system_id = ${msId} and code = ${code}
         order by (deleted_at is null) desc, created_at desc limit 1`.execute(trx)).rows;
      break;
    case 'management_review':
      rows = (await sql<{ id: string }>`
        select id from management_review where code = ${code} order by (deleted_at is null) desc, created_at desc limit 1`.execute(trx)).rows;
      break;
  }
  const id = rows[0]?.id;
  if (!id || rows.length > 1) throw new NotFoundError(`No ${recordClass.replace(/_/g, ' ')} with the code ${code} in this system`);
  return id;
}

/**
 * Open records that still rely on a record (as `records.delete` refuses them with `records.open_dependants`): open
 * corrective actions of a finding, open findings raised at an audit event. Codes, in order.
 */
export async function openDependants(trx: Trx, recordClass: RetentionRecordClass, itemId: string): Promise<string[]> {
  if (recordClass === 'finding') {
    const { rows } = await sql<{ code: string }>`
      select ca.code from corrective_action_finding cf join corrective_action ca on ca.id = cf.corrective_action_id
       where cf.finding_id = ${itemId} and cf.deleted_at is null and ca.deleted_at is null and ca.status not in ('closed', 'cancelled')
       order by ca.code`.execute(trx);
    return rows.map((r) => r.code);
  }
  if (recordClass === 'audit_event') {
    const { rows } = await sql<{ code: string }>`
      select code from finding where audit_event_id = ${itemId} and deleted_at is null and status <> 'closed' order by code`.execute(trx);
    return rows.map((r) => r.code);
  }
  return [];
}
