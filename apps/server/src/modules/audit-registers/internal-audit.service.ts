// Internal audit programme (Milestone 2 D.1 `internal-audit.programme`, M2-05) and the clause or control codes that
// audit activities and findings name (`targetCode`, D.2):
// - `GET /ms/{ms}/internal-audit/programme`: for a certification cycle (the one asked for, else the open cycle, else
//   the newest), every clause row of groups 4 to 10 of the system's edition and every applicable control, each with
//   the internal audit events of the cycle whose activities covered it; a row without audits is not covered yet. An
//   activity covers the code it targets (`target_code`, else its template `clause_ref`), the sub-clauses of a clause
//   it targets, and the parent clauses of a sub-clause it targets. Rows no longer in the standard (retired) are left
//   out; cancelled activities do not count.
// - `targetOf`: a code of the system's edition, a catalogue item (control) or a requirement (clause), for the
//   `targetCode` of activities and findings; unknown codes and codes no longer in the standard answer 422.
import { Inject, Injectable } from '@nestjs/common';
import type { InternalAuditProgramme, InternalAuditProgrammeQuery } from '@mscd/shared';
import { sql } from 'kysely';
import { NotFoundError } from '../../common/problems';
import { RECORD_RESOLVER, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { unprocessable } from './support';

export interface EditionTarget {
  kind: 'clause' | 'control';
  code: string;
  title: string;
}

/**
 * The clause or control `code` names in the edition of a system (D.2 `targetCode`, a code of `applicability.targets`):
 * a requirement code (clause) or a catalogue item code (control). 422 for a code the edition does not have, or one
 * that is no longer in the standard.
 */
export async function targetOf(trx: Trx, msId: string, code: string): Promise<EditionTarget> {
  const { rows } = await sql<{ kind: 'clause' | 'control'; code: string; title: string; retired: boolean }>`
    select 'control' as kind, ci.item_code as code, ci.title_short as title, ci.retired from ref.catalogue_item ci
      join management_system m on m.framework_version_id = ci.framework_version_id
     where m.id = ${msId} and ci.item_code = ${code}
    union all
    select 'clause' as kind, rq.requirement_code as code, rq.title_short as title, rq.retired from ref.requirement rq
      join management_system m on m.framework_version_id = rq.framework_version_id
     where m.id = ${msId} and rq.requirement_code = ${code}`.execute(trx);
  const live = rows.find((r) => !r.retired);
  if (live) return { kind: live.kind, code: live.code, title: live.title };
  if (rows.length > 0) {
    throw unprocessable('audit.target_retired', `${code} is no longer in the standard`, `${code} tidak lagi ada dalam standar`);
  }
  throw unprocessable('audit.unknown_target', `${code} is not a clause or control of the edition in use`, `${code} bukan klausul atau kontrol dari edisi yang digunakan`);
}

/** True when an activity target (or template clause reference) `target` covers the programme row `code`. */
export function covers(target: string, code: string, kind: 'clause' | 'control'): boolean {
  if (target === code) return true;
  if (kind === 'control') return false;
  return code.startsWith(`${target}.`) || target.startsWith(`${code}.`);
}

interface ProgrammeCycle {
  id: string;
  cycle_start: string;
  cycle_end: string;
}

@Injectable()
export class InternalAuditService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
  ) {}

  programme(principal: Principal, ms: string, query: InternalAuditProgrammeQuery): Promise<InternalAuditProgramme> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const cycle = await this.cycleOf(trx, system.id, query.cycle);
      const { rows: clauses } = await sql<{ code: string; title: string; clause_group: string }>`
        select rq.requirement_code as code, rq.title_short as title, rq.clause_group
          from ref.requirement rq join management_system m on m.framework_version_id = rq.framework_version_id
         where m.id = ${system.id} and not rq.retired and rq.clause_group in ('4', '5', '6', '7', '8', '9', '10')
         order by rq.clause_group::int, rq.sort_order, rq.requirement_code`.execute(trx);
      // Applicable controls: catalogue items with a live entry of the system that is not marked not applicable.
      const { rows: controls } = await sql<{ code: string; title: string }>`
        select ci.item_code as code, ci.title_short as title
          from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
         where e.management_system_id = ${system.id} and e.deleted_at is null and not ci.retired
           and e.is_applicable is not false and e.implementation_status is distinct from 'not_applicable'
         order by ci.sort_order, ci.item_code`.execute(trx);
      // Internal audit events of the system in the cycle (linked to it, or unlinked and dated within it), with the
      // targets of their activities.
      const cycleFilter = cycle
        ? sql`and (e.certification_cycle_id = ${cycle.id}
                   or (e.certification_cycle_id is null and e.scheduled_at between ${cycle.cycle_start}::date and ${cycle.cycle_end}::date))`
        : sql``;
      const { rows: activities } = await sql<{ event_id: string; short_label: string; scheduled_at: string; target: string | null }>`
        select e.id as event_id, e.short_label, e.scheduled_at, coalesce(a.target_code, nullif(btrim(a.clause_ref), '')) as target
          from audit_event e
          left join audit_activity a on a.audit_event_id = e.id and a.management_system_id = ${system.id} and a.deleted_at is null and a.status <> 'cancelled'
         where e.deleted_at is null and e.event_type = 'internal_audit'
           and (e.management_system_id = ${system.id}
                or exists (select 1 from entity_ms_link l where l.entity_type = 'audit_event' and l.entity_id = e.id
                             and l.management_system_id = ${system.id} and l.deleted_at is null))
           ${cycleFilter}
         order by e.scheduled_at, e.id`.execute(trx);
      const rowOf = (code: string, title: string, kind: 'clause' | 'control', clauseGroup: string | null): InternalAuditProgramme['rows'][number] => {
        const audits = new Map<string, { eventId: string; shortLabel: string; scheduledAt: string; activities: number }>();
        for (const a of activities) {
          if (!a.target || !covers(a.target, code, kind)) continue;
          const audit = audits.get(a.event_id) ?? { eventId: a.event_id, shortLabel: a.short_label, scheduledAt: a.scheduled_at, activities: 0 };
          audit.activities += 1;
          audits.set(a.event_id, audit);
        }
        const list = [...audits.values()];
        return { code, title, kind, clauseGroup: clauseGroup as InternalAuditProgramme['rows'][number]['clauseGroup'], covered: list.length > 0, audits: list };
      };
      return {
        cycle: cycle ? { id: cycle.id, cycleStart: cycle.cycle_start, cycleEnd: cycle.cycle_end } : null,
        rows: [...clauses.map((c) => rowOf(c.code, c.title, 'clause', c.clause_group)), ...controls.map((c) => rowOf(c.code, c.title, 'control', null))],
      };
    });
  }

  /** The cycle of the programme: the one asked for (404 when it is not a cycle of the system), else the open or newest. */
  private async cycleOf(trx: Trx, msId: string, id: string | undefined): Promise<ProgrammeCycle | null> {
    if (id) {
      const { rows } = await sql<ProgrammeCycle>`
        select id, cycle_start, cycle_end from certification_cycle where id = ${id} and management_system_id = ${msId} and deleted_at is null`.execute(trx);
      if (!rows[0]) throw new NotFoundError('Unknown certification cycle');
      return rows[0];
    }
    const { rows } = await sql<ProgrammeCycle>`
      select id, cycle_start, cycle_end from certification_cycle where management_system_id = ${msId} and deleted_at is null
       order by (status in ('planned', 'active')) desc, cycle_start desc, created_at desc limit 1`.execute(trx);
    return rows[0] ?? null;
  }
}
