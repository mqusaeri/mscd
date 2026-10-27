// Clause readiness (Milestone 2 D.6, D2-11, M2-05): for each management system and clause group 4 to 10, four
// dimensions computed from the stored data, and the readiness as their mean:
// - implemented: share of the group's applicability entries that are implemented or not applicable. Requirement
//   entries group by `ref.requirement.clause_group`; catalogue entries by the clause group of the requirement their
//   catalogue item names (`requirement_id`), else group 8;
// - documented: share of the group's `ref.documented_info` rows that are in place, found as the documented information
//   list of M2-07 finds them: for documented information to maintain, an approved document of the system (its own,
//   shared or organisation-wide) that is not past its review date, by the template code, by the system's
//   `document_code_link` of the template or row code, or among the implementing documents of the requirement entry of
//   the clause (or of its sub-clauses); for documented information to retain (records), a fresh evidence item of such
//   an entry;
// - evidenced: share of the group's evidence items (linked to an entry of the group) that are fresh;
// - measured: group 9 only, share of the system's metrics with a value in the current period (a value period that
//   ended within one period of today, the period of the metric's frequency, 365 days without one);
// - readiness: the rounded mean of the dimensions that have rows; null when none has rows.
// Rows and entries no longer in the standard (retired) are left out. A row with `source = 'manual'` is never
// overwritten (the demo seed writes its rows so); every other row is written as `computed` with `computed_at`.
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { SYSTEM_USER_ID, type Trx } from '../../../common/tokens';

/** Clause groups of readiness (Harmonized Structure clauses 4 to 10). */
export const READINESS_GROUPS = [4, 5, 6, 7, 8, 9, 10] as const;

/** Days of the current period of a metric without a frequency (D.6 measured). */
const DEFAULT_METRIC_PERIOD_DAYS = 365;

export interface GroupReadiness {
  group: number;
  readiness: number | null;
  documented: number | null;
  implemented: number | null;
  evidenced: number | null;
  measured: number | null;
}

export interface SystemReadiness {
  msId: string;
  slug: string;
  groups: GroupReadiness[];
  /** Groups whose stored row is `manual` and was left as it is. */
  manual: number[];
}

/** A share in percent, rounded; null when there is nothing to count. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((100 * part) / whole) : null;
}

/** The readiness of a group: the rounded mean of the dimensions that have rows, null when none has. */
export function readinessOf(dimensions: readonly (number | null)[]): number | null {
  const present = dimensions.filter((d): d is number => d !== null);
  return present.length > 0 ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
}

/** The clause group of a requirement code when the edition does not name it: the number before the first dot. */
export function groupOfCode(code: string): number | null {
  const n = Number.parseInt(code.split('.')[0] ?? '', 10);
  return Number.isInteger(n) && n >= 4 && n <= 10 ? n : null;
}

interface Counts {
  part: number;
  whole: number;
}

function counter(): Map<number, Counts> {
  return new Map(READINESS_GROUPS.map((g) => [g, { part: 0, whole: 0 }]));
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger('readiness.recompute');

  /**
   * Computes and stores the clause readiness of one system, or of every system of the organisation that is not
   * archived, in the caller's tenant transaction, for the organisation's local date `today`.
   */
  async recompute(trx: Trx, today: string, msId?: string | null): Promise<SystemReadiness[]> {
    const { rows: systems } = await sql<{ id: string; slug: string; framework_version_id: string }>`
      select id, slug, framework_version_id from management_system
       where deleted_at is null and status <> 'archived' and (${msId ?? null}::uuid is null or id = ${msId ?? null}::uuid)
       order by position, slug`.execute(trx);
    const out: SystemReadiness[] = [];
    for (const system of systems) {
      const groups = await this.compute(trx, system.id, system.framework_version_id, today);
      const manual = await this.store(trx, system.id, groups);
      out.push({ msId: system.id, slug: system.slug, groups, manual });
    }
    this.logger.debug({ systems: out.length }, 'readiness.recompute: systems computed');
    return out;
  }

  /** The four dimensions and the readiness of every clause group of one system (D.6). */
  async compute(trx: Trx, msId: string, editionId: string, today: string): Promise<GroupReadiness[]> {
    // Entries of the system in the standard, with their clause group.
    const { rows: entries } = await sql<{ id: string; grp: string | null; done: boolean }>`
      select e.id,
             case when e.requirement_id is not null then rq.clause_group else coalesce(crq.clause_group, '8') end as grp,
             (e.implementation_status in ('implemented', 'not_applicable') or e.is_applicable is false) as done
        from applicability_entry e
        left join ref.requirement rq on rq.id = e.requirement_id
        left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement crq on crq.id = ci.requirement_id
       where e.management_system_id = ${msId} and e.deleted_at is null
         and not coalesce(rq.retired, false) and not coalesce(ci.retired, false)`.execute(trx);
    const implemented = counter();
    for (const e of entries) {
      const c = implemented.get(Number(e.grp));
      if (!c) continue;
      c.whole += 1;
      if (e.done) c.part += 1;
    }

    // Evidence items linked to an entry of the group (once per group), fresh or not.
    const { rows: evidence } = await sql<{ grp: string; fresh: boolean }>`
      select distinct case when e.requirement_id is not null then rq.clause_group else coalesce(crq.clause_group, '8') end as grp,
             ev.id, ev.freshness_status = 'fresh' as fresh
        from applicability_entry e
        join evidence_target et on et.applicability_entry_id = e.id and et.deleted_at is null
        join evidence ev on ev.id = et.evidence_id and ev.deleted_at is null
        left join ref.requirement rq on rq.id = e.requirement_id
        left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement crq on crq.id = ci.requirement_id
       where e.management_system_id = ${msId} and e.deleted_at is null
         and not coalesce(rq.retired, false) and not coalesce(ci.retired, false)`.execute(trx);
    const evidenced = counter();
    for (const ev of evidence) {
      const c = evidenced.get(Number(ev.grp));
      if (!c) continue;
      c.whole += 1;
      if (ev.fresh) c.part += 1;
    }

    // Documented information of the edition, each row with whether it is in place for this system.
    const { rows: documented } = await sql<{ code: string; requirement_code: string; clause_group: string | null; in_place: boolean }>`
      with system_docs as (
        select d.id, d.doc_code from document d
         where d.deleted_at is null and d.status = 'approved' and (d.next_review_at is null or d.next_review_at >= ${today}::date)
           and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                           and l.management_system_id = ${msId} and l.deleted_at is null))),
      di_rows as (
        select di.code, di.requirement_code, di.kind, di.template_code, rq.clause_group
          from ref.documented_info di
          left join ref.requirement rq on rq.framework_version_id = di.framework_version_id and rq.requirement_code = di.requirement_code
         where di.framework_version_id = ${editionId} and not coalesce(rq.retired, false)),
      row_entries as (
        select r.code, e.id as entry_id
          from di_rows r
          join applicability_entry e on e.management_system_id = ${msId} and e.deleted_at is null and e.target_type = 'requirement'
          join ref.requirement erq on erq.id = e.requirement_id and not erq.retired
         where erq.requirement_code = r.requirement_code or starts_with(erq.requirement_code, r.requirement_code || '.'))
      select r.code, r.requirement_code, r.clause_group,
             case when r.kind = 'retain' then exists (
                    select 1 from row_entries re
                      join evidence_target et on et.applicability_entry_id = re.entry_id and et.deleted_at is null
                      join evidence ev on ev.id = et.evidence_id and ev.deleted_at is null and ev.freshness_status = 'fresh'
                     where re.code = r.code)
                  else (
                    exists (select 1 from system_docs sd where r.template_code is not null and sd.doc_code = r.template_code)
                    or exists (select 1 from document_code_link k join system_docs sd on sd.id = k.document_id
                                where k.management_system_id = ${msId} and k.deleted_at is null and k.pack_code in (r.template_code, r.code))
                    or exists (select 1 from row_entries re
                                 join applicability_entry_document ad on ad.applicability_entry_id = re.entry_id and ad.deleted_at is null
                                 join system_docs sd on sd.id = ad.document_id
                                where re.code = r.code))
             end as in_place
        from di_rows r`.execute(trx);
    const documentedCounts = counter();
    for (const row of documented) {
      const c = documentedCounts.get(row.clause_group !== null ? Number(row.clause_group) : (groupOfCode(row.requirement_code) ?? 0));
      if (!c) continue;
      c.whole += 1;
      if (row.in_place) c.part += 1;
    }

    // Metrics of the system (group 9) with a value in the current period.
    const { rows: metrics } = await sql<{ current: boolean }>`
      select exists (
               select 1 from metric_value v
                where v.metric_id = m.id and v.deleted_at is null
                  and v.period_end > (${today}::date - coalesce(f.period_days, ${DEFAULT_METRIC_PERIOD_DAYS}))
             ) or (m.last_measured_at is not null and m.last_measured_at > (${today}::date - coalesce(f.period_days, ${DEFAULT_METRIC_PERIOD_DAYS})))
             as current
        from metric m
        left join ref.evidence_frequency_rule f on f.framework_version_id = ${editionId} and f.code = m.frequency_code
       where m.deleted_at is null
         and exists (select 1 from entity_ms_link l where l.entity_type = 'metric' and l.entity_id = m.id
                       and l.management_system_id = ${msId} and l.deleted_at is null)`.execute(trx);
    const measured = share(metrics.filter((m) => m.current).length, metrics.length);

    return READINESS_GROUPS.map((group) => {
      const dims = {
        documented: share(documentedCounts.get(group)!.part, documentedCounts.get(group)!.whole),
        implemented: share(implemented.get(group)!.part, implemented.get(group)!.whole),
        evidenced: share(evidenced.get(group)!.part, evidenced.get(group)!.whole),
        measured: group === 9 ? measured : null,
      };
      return { group, readiness: readinessOf([dims.documented, dims.implemented, dims.evidenced, dims.measured]), ...dims };
    });
  }

  /** Writes the computed rows of a system; returns the groups left alone because their row is `manual`. */
  private async store(trx: Trx, msId: string, groups: readonly GroupReadiness[]): Promise<number[]> {
    const { rows: stored } = await sql<{ id: string; clause_group: number; source: string }>`
      select id, clause_group, source from clause_readiness
       where management_system_id = ${msId} and deleted_at is null
       for update`.execute(trx);
    const byGroup = new Map(stored.map((r) => [Number(r.clause_group), r]));
    const manual: number[] = [];
    for (const g of groups) {
      const row = byGroup.get(g.group);
      if (row?.source === 'manual') {
        manual.push(g.group);
        continue;
      }
      if (row) {
        await sql`update clause_readiness
                     set readiness_pct = ${g.readiness}, documented_pct = ${g.documented}, implemented_pct = ${g.implemented},
                         evidenced_pct = ${g.evidenced}, measured_pct = ${g.measured}, computed_at = now(), source = 'computed',
                         updated_by = ${SYSTEM_USER_ID}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
                   where id = ${row.id}`.execute(trx);
      } else {
        await sql`insert into clause_readiness (management_system_id, clause_group, readiness_pct, documented_pct, implemented_pct, evidenced_pct,
                                                measured_pct, computed_at, source, created_by, updated_by)
                  values (${msId}, ${g.group}, ${g.readiness}, ${g.documented}, ${g.implemented}, ${g.evidenced}, ${g.measured}, now(), 'computed',
                          ${SYSTEM_USER_ID}, ${SYSTEM_USER_ID})`.execute(trx);
      }
    }
    return manual;
  }
}
