// The applicability entries a management system starts with (Milestone 2 D2-09, E.3): one entry per catalogue item
// of the active edition (the Annex A controls of ISO/IEC 27001) plus one per leaf clause row, or one per leaf
// requirement for a standard without a catalogue. A leaf row has no child row that is still in the standard; retired
// rows (E.1) get no entry. Entries that already exist are left alone, so the seeder is idempotent: it is used when a
// system is created (`admin.ms.create`, M2-06, every target) and by `applicability.sync` after a pack update (E.3,
// M2-03, only the targets that are new in the waiting versions). An entry the team deleted counts as existing, so the
// seeder never creates it again.
//
// Seeded entries are applicable, `not_started` and unassigned (H.8 default): the team excludes items with a
// justification and assigns owners. Clause rows can never be marked not applicable (`applicability_assessable`). The
// caller audits the seeding (`applicability.seeded` or `pack.content_synced`) and queues the recomputations.
import { sql } from 'kysely';
import { SYSTEM_USER_ID, type Trx } from '../../common/tokens';

/** One target of the seeded set, in pack order. */
export interface SeedTarget {
  targetType: 'catalogue_item' | 'requirement';
  /** `ref.catalogue_item.id` or `ref.requirement.id`. */
  refId: string;
  /** Item code (`A.5.1`) or clause code (`4.1`). */
  code: string;
}

export interface SeededEntry extends SeedTarget {
  /** `applicability_entry.id` of the new entry. */
  id: string;
}

export interface SeedApplicabilityResult {
  /** The framework version whose rows were seeded (the system's active edition). */
  frameworkVersionId: string;
  /** Entries created by this call, in pack order (catalogue items first, then clause rows). */
  added: SeededEntry[];
  /** Targets of this call that already had an entry, also a deleted one. */
  existing: number;
}

export interface SeedApplicabilityOptions {
  /** `created_by` and `updated_by` of the new entries (default: the system user). */
  actorUserId?: string;
  /**
   * Only these targets (`targetKey`); targets not listed are left alone, and a listed key that is no target of the
   * edition (retired, or no longer a leaf) is ignored. `applicability.sync` passes the targets new in the waiting
   * versions, so a system keeps the set of entries its team chose (E.3). Omitted: every target (system creation).
   */
  only?: ReadonlySet<string>;
}

/** Key of a seed target, also used in the change summary of a pack update: `catalogue_item:A.5.1`, `requirement:9.2.1`. */
export function targetKey(targetType: SeedTarget['targetType'], code: string): string {
  return `${targetType}:${code}`;
}

/**
 * The D2-09 target keys of a set of rows, in the order given (catalogue items first): catalogue items that are not
 * retired, and requirements that are not retired and have no child row that is not retired. The pack update compares
 * the keys of the installed rows with those of the new version (pack-content-diff.ts), with the rule of `seedTargets`.
 */
export function targetKeysOf(
  requirements: Iterable<{ code: string; parent: string | null; retired: boolean }>,
  catalogue: Iterable<{ code: string; retired: boolean }>,
): string[] {
  const rows = [...requirements];
  const parents = new Set(rows.filter((r) => !r.retired && r.parent !== null).map((r) => r.parent as string));
  return [
    ...[...catalogue].filter((c) => !c.retired).map((c) => targetKey('catalogue_item', c.code)),
    ...rows.filter((r) => !r.retired && !parents.has(r.code)).map((r) => targetKey('requirement', r.code)),
  ];
}

/**
 * The D2-09 targets of a framework version: catalogue items that are not retired, then leaf requirements that are
 * not retired (clause rows from 4.1 to 10.2), each in pack order.
 */
export async function seedTargets(trx: Trx, frameworkVersionId: string): Promise<SeedTarget[]> {
  const items = await sql<{ id: string; code: string }>`
    select c.id, c.item_code as code
      from ref.catalogue_item c
     where c.framework_version_id = ${frameworkVersionId} and not c.retired
     order by c.sort_order, c.item_code`.execute(trx);
  const requirements = await sql<{ id: string; code: string }>`
    select r.id, r.requirement_code as code
      from ref.requirement r
     where r.framework_version_id = ${frameworkVersionId} and not r.retired
       and not exists (select 1 from ref.requirement child where child.parent_id = r.id and not child.retired)
     order by r.sort_order, r.requirement_code`.execute(trx);
  return [
    ...items.rows.map((r) => ({ targetType: 'catalogue_item' as const, refId: r.id, code: r.code })),
    ...requirements.rows.map((r) => ({ targetType: 'requirement' as const, refId: r.id, code: r.code })),
  ];
}

/**
 * Creates the D2-09 applicability entries of a system that are still missing (all of them, or the targets in
 * `options.only`), in the caller's tenant transaction. Skips retired rows and targets that already have an entry; a
 * deleted entry counts, so an entry the team removed is never created again. Throws when the system does not exist in
 * the organisation of the transaction.
 */
export async function seedApplicability(trx: Trx, msId: string, options: SeedApplicabilityOptions = {}): Promise<SeedApplicabilityResult> {
  const system = await trx
    .selectFrom('management_system')
    .select(['id', 'framework_version_id'])
    .where('id', '=', msId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!system) throw new Error(`seedApplicability: management system ${msId} does not exist`);
  // One seeding of a system at a time: two concurrent runs would both see the target as missing.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`applicability-seed:${msId}`}, 0))`.execute(trx);

  const all = await seedTargets(trx, system.framework_version_id);
  const only = options.only;
  const targets = only ? all.filter((t) => only.has(targetKey(t.targetType, t.code))) : all;
  if (targets.length === 0) return { frameworkVersionId: system.framework_version_id, added: [], existing: 0 };
  // Deleted entries are read too: the team removed them on purpose.
  const entries = await trx
    .selectFrom('applicability_entry')
    .select(['catalogue_item_id', 'requirement_id'])
    .where('management_system_id', '=', msId)
    .execute();
  const have = new Set(entries.flatMap((e) => [e.catalogue_item_id, e.requirement_id]).filter((id): id is string => id !== null));
  const missing = targets.filter((t) => !have.has(t.refId));
  if (missing.length === 0) return { frameworkVersionId: system.framework_version_id, added: [], existing: targets.length };

  const next = await sql<{ next: number }>`
    select coalesce(max(position), -1)::int + 1 as next from applicability_entry where management_system_id = ${msId}`.execute(trx);
  const first = next.rows[0]?.next ?? 0;
  const actor = options.actorUserId ?? SYSTEM_USER_ID;
  const inserted = await trx
    .insertInto('applicability_entry')
    .values(
      missing.map((t, i) => ({
        management_system_id: msId,
        target_type: t.targetType,
        catalogue_item_id: t.targetType === 'catalogue_item' ? t.refId : null,
        requirement_id: t.targetType === 'requirement' ? t.refId : null,
        is_applicable: true,
        implementation_status: 'not_started' as const,
        owner_user_id: null,
        position: first + i,
        created_by: actor,
        updated_by: actor,
      })),
    )
    .returning(['id', 'catalogue_item_id', 'requirement_id'])
    .execute();
  const idByTarget = new Map(inserted.map((row) => [(row.catalogue_item_id ?? row.requirement_id) as string, row.id]));
  return {
    frameworkVersionId: system.framework_version_id,
    added: missing.map((t) => ({ ...t, id: idByTarget.get(t.refId) as string })),
    existing: targets.length - missing.length,
  };
}
