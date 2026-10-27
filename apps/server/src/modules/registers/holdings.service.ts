// Holdings and handover (Milestone 2 D.1 `records.holdings`, `records.holdings.reassign`, `admin.users.holdings`,
// H.13, product decision 2): every open item a person holds in a system, and its handover to a successor.
//
// Kinds (`HOLDING_KINDS`): applicability entries (owner or justification holder), activities not verified,
// documents as owner or pending review holder (`document_owner`) and as approver (`document_approver`), evidence,
// risks, risk treatments not closed or accepted, findings not closed (and the open gaps of the self-assessment the
// person owns), corrective actions not closed or cancelled, preparation tasks and cycle items not done (and the
// planned audit activities where the person is the auditor or the auditee), register rows (the other register and
// chain record tables, business associates also as relationship owner, and the management reviews the person owns
// that are not closed) and tasks (open stored tasks, and the unresolved drift results the person holds through
// `records.assign` kind `drift`).
//
// The MS Manager and the Programme Owner (`record.assign`) see the items of one system with codes and titles; the
// Tenant Admin (`user.manage`) sees counts per system and kind with the primary manager of each system, never a
// title (F.6). A handover moves every chosen kind in one transaction: each record's holder columns that name the
// person move to the successor, BR-16 (a successor who wrote the version in review cannot approve it), BR-17 (a
// risk keeps an owner), BR-41 (a due date after the next audit; not for audit activities, whose date is their own
// scheduled date) and AUD-INDEP (a successor who becomes the auditor of an activity examines their own work) are
// checked per record and answered as warnings that name the record, each record gets its `holdings.reassigned` audit
// entry, and records shared with other systems need the BR-22 confirmation first.
import { Inject, Injectable } from '@nestjs/common';
import {
  HOLDING_KINDS,
  type CommandResult,
  type HoldingKind,
  type Holdings,
  type HoldingsReassign,
  type RecordRef,
  type UserHoldings,
  type Warning,
} from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { Clock } from '../../common/clock';
import { NotFoundError, ProblemError } from '../../common/problems';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, RECORD_RESOLVER, type AuditWriter, type MembershipService, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import type { AudIndepInput } from '../audit-registers/internal-audit.rules';
import { entryBusinessId } from '../implementation';
import { competenceCode } from '../risk-registers/competence';
import { confirmShared, type Br17Input } from '../risk-registers/rules';
import { mergeWarnings, RuleEngine, type RuleFinding } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { commandResult, nextAuditDate, orgOf, refOf, todayOf } from './command-support';
import type { Br16Input, Br41Input } from './register.rules';

/** One held record as the holding queries return it. */
interface HeldRow {
  tbl: string;
  id: string;
  updated_at: Date;
  code: string | null;
  title: string;
  due_at: string | null;
  /** Holder columns of the record that name the person. */
  columns: string[];
  /** Slugs of the other systems the record also belongs to (shared records, BR-22). */
  other_ms: string[] | null;
  target_type: 'catalogue_item' | 'requirement' | null;
}

/** A held record with its kind. */
interface Held extends HeldRow {
  kind: HoldingKind;
}

/** Register and chain record tables of `register_row`: linked through `entity_ms_link`, or rows of one system. */
const LINKED_REGISTERS = ['context_issue', 'interested_party', 'asset', 'metric', 'competence_record'] as const;
const OWNED_REGISTERS = [
  'quality_objective', 'process', 'prioritized_activity', 'business_impact_analysis', 'bc_plan', 'exercise', 'business_associate', 'chain_record',
] as const;
/**
 * Holder columns of `register_row` tables with more than the owner: the relationship owner of a business associate,
 * whom the drift rules treat as its holder (`drift.service.ts`).
 */
const REGISTER_HOLDERS: Readonly<Record<string, readonly string[]>> = {
  business_associate: ['owner_user_id', 'relationship_owner_user_id'],
};
/** Holder columns of an audit activity: the auditor (Milestone 2 D.2) and the auditee. */
const AUDIT_ACTIVITY_HOLDERS = ['auditor_user_id', 'auditee_user_id'] as const;
/** Tables of `register_row` with `action_due_at`. */
const ACTION_DUE: ReadonlySet<string> = new Set([
  'context_issue', 'metric', 'competence_record', 'prioritized_activity', 'business_impact_analysis', 'exercise', 'business_associate', 'chain_record',
  'quality_objective',
]);

/** `array_remove(array[...], null)` of the columns that name the person. */
function columnsNaming(alias: string, columns: readonly string[], userId: string): RawBuilder<string[]> {
  return sql<string[]>`array_remove(array[${sql.join(columns.map((c) => sql`case when ${sql.ref(`${alias}.${c}`)} = ${userId}::uuid then ${c} end`))}]::text[], null)`;
}

/** `(c1 = u or c2 = u ...)` */
function namedBy(alias: string, columns: readonly string[], userId: string): RawBuilder<boolean> {
  return sql<boolean>`(${sql.join(columns.map((c) => sql`${sql.ref(`${alias}.${c}`)} = ${userId}::uuid`), sql` or `)})`;
}

/** Other systems of a record linked through `entity_ms_link`. */
function otherLinked(table: string, alias: string, msId: string): RawBuilder<string[]> {
  return sql<string[]>`(select array_agg(m.slug order by m.slug) from entity_ms_link l join management_system m on m.id = l.management_system_id and m.deleted_at is null
     where l.entity_type = ${table} and l.entity_id = ${sql.ref(`${alias}.id`)} and l.deleted_at is null and l.management_system_id <> ${msId}::uuid)`;
}

/** In the system through `entity_ms_link`. */
function linkedTo(table: string, alias: string, msId: string): RawBuilder<boolean> {
  return sql<boolean>`exists (select 1 from entity_ms_link l where l.entity_type = ${table} and l.entity_id = ${sql.ref(`${alias}.id`)}
     and l.management_system_id = ${msId}::uuid and l.deleted_at is null)`;
}

/** The queries of one holding kind for a system and a person, one per table (`lock`: the rows are locked for a handover). */
function heldQueries(kind: HoldingKind, msId: string, userId: string, lock: boolean): RawBuilder<HeldRow>[] {
  const forUpdate = lock ? sql` for update of t` : sql``;
  const none = sql<string[]>`null::text[]`;
  switch (kind) {
    case 'applicability_entry': {
      const cols = ['owner_user_id', 'justification_holder_user_id'];
      return [sql<HeldRow>`
        select 'applicability_entry' as tbl, t.id, t.updated_at, coalesce(ci.item_code, rq.requirement_code) as code,
               coalesce(ci.title_short, rq.title_short) as title, coalesce(t.action_due_at, t.justification_due_at) as due_at,
               ${columnsNaming('t', cols, userId)} as columns, ${none} as other_ms, t.target_type
          from applicability_entry t
          left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
          left join ref.requirement rq on rq.id = t.requirement_id
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and ${namedBy('t', cols, userId)}
         order by t.position, t.id${forUpdate}`];
    }
    case 'activity':
      return [sql<HeldRow>`
        select 'implementation_activity_progress' as tbl, t.id, t.updated_at, t.phase_no || '.' || t.activity_no as code, t.title, t.due_at,
               array['owner_user_id'] as columns, ${none} as other_ms, null as target_type
          from implementation_activity_progress t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status <> 'verified'
         order by t.phase_no, t.activity_no${forUpdate}`];
    case 'document_owner':
    case 'document_approver': {
      const cols = kind === 'document_owner' ? ['owner_user_id', 'pending_holder_user_id'] : ['approver_user_id'];
      const due = kind === 'document_owner'
        ? sql`case when t.pending_holder_user_id = ${userId}::uuid then t.pending_due_at else t.next_review_at end`
        : sql`null::date`;
      return [sql<HeldRow>`
        select 'document' as tbl, t.id, t.updated_at, t.doc_code as code, t.title, ${due} as due_at, ${columnsNaming('t', cols, userId)} as columns,
               case when t.is_org_wide
                    then (select array_agg(m.slug order by m.slug) from management_system m where m.deleted_at is null and m.id <> ${msId}::uuid)
                    else ${otherLinked('document', 't', msId)} end as other_ms,
               null as target_type
          from document t
         where t.deleted_at is null and (t.is_org_wide or ${linkedTo('document', 't', msId)}) and ${namedBy('t', cols, userId)}
         order by t.position, t.doc_code${forUpdate}`];
    }
    case 'evidence':
      return [sql<HeldRow>`
        select 'evidence' as tbl, t.id, t.updated_at, t.evidence_code as code, t.title, t.next_due_override as due_at,
               array['owner_user_id'] as columns,
               (select array_agg(distinct m.slug) from evidence_target x join management_system m on m.id = x.management_system_id and m.deleted_at is null
                 where x.evidence_id = t.id and x.deleted_at is null and x.management_system_id <> ${msId}::uuid) as other_ms,
               null as target_type
          from evidence t
         where t.deleted_at is null and t.owner_user_id = ${userId}::uuid
           and exists (select 1 from evidence_target x where x.evidence_id = t.id and x.management_system_id = ${msId}::uuid and x.deleted_at is null)
         order by t.position, t.evidence_code${forUpdate}`];
    case 'risk':
      return [sql<HeldRow>`
        select 'risk' as tbl, t.id, t.updated_at, t.code, t.title, coalesce(t.action_due_at, t.next_review_at) as due_at,
               array['owner_user_id'] as columns, ${otherLinked('risk', 't', msId)} as other_ms, null as target_type
          from risk t
         where t.deleted_at is null and t.owner_user_id = ${userId}::uuid and ${linkedTo('risk', 't', msId)}
         order by t.position, t.code${forUpdate}`];
    case 'risk_treatment':
      return [sql<HeldRow>`
        select 'risk_treatment' as tbl, t.id, t.updated_at, t.code, t.title, coalesce(t.action_due_at, t.target_date) as due_at,
               array['owner_user_id'] as columns, ${none} as other_ms, null as target_type
          from risk_treatment t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid
           and t.status not in ('residual_accepted', 'closed')
         order by t.position, t.code${forUpdate}`];
    case 'finding':
      return [
        sql<HeldRow>`
        select 'finding' as tbl, t.id, t.updated_at, t.code, t.title, t.due_at, array['owner_user_id'] as columns, ${none} as other_ms, null as target_type
          from finding t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status <> 'closed'
         order by t.position, t.code${forUpdate}`,
        // Open gaps of the self-assessment the person owns (a gap needs an owner and a target date, PRD 8.1): the gap
        // stays theirs until it is assessed again, whether or not a finding was raised from it.
        sql<HeldRow>`
        select 'self_assessment' as tbl, t.id, t.updated_at, c.code, c.text as title, t.target_fix_at as due_at,
               array['owner_user_id'] as columns, ${none} as other_ms, null as target_type
          from self_assessment t join ref.finding_condition c on c.id = t.finding_condition_id
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status = 'gap'
         order by c.code${forUpdate}`,
      ];
    case 'corrective_action':
      return [sql<HeldRow>`
        select 'corrective_action' as tbl, t.id, t.updated_at, t.code, t.title, t.due_at, array['owner_user_id'] as columns, ${none} as other_ms,
               null as target_type
          from corrective_action t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid
           and t.status not in ('closed', 'cancelled')
         order by t.code${forUpdate}`];
    case 'prep_task':
    case 'cycle_item': {
      const table = kind === 'prep_task' ? 'audit_prep_task' : 'cycle_requirement_status';
      const code = kind === 'prep_task' ? sql`coalesce(t.template_code, left(t.title, 30))` : sql`t.requirement_code`;
      const parts: RawBuilder<HeldRow>[] = [sql<HeldRow>`
        select ${table} as tbl, t.id, t.updated_at, ${code} as code, t.title, t.due_at, array['owner_user_id'] as columns, ${none} as other_ms,
               null as target_type
          from ${sql.table(table)} t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status <> 'done'
         order by t.due_at, t.id${forUpdate}`];
      if (kind === 'prep_task') {
        // Planned audit activities (internal audits of M2-05 and the certification audit planner) where the person
        // is the auditor or the auditee, due on their scheduled date; the code is the one the planner shows.
        parts.push(sql<HeldRow>`
          select 'audit_activity' as tbl, t.id, t.updated_at, coalesce(t.template_code, t.title) as code, t.title, t.scheduled_at as due_at,
                 ${columnsNaming('t', AUDIT_ACTIVITY_HOLDERS, userId)} as columns, ${none} as other_ms, null as target_type
            from audit_activity t
           where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.status = 'planned'
             and ${namedBy('t', AUDIT_ACTIVITY_HOLDERS, userId)}
             and exists (select 1 from audit_event e where e.id = t.audit_event_id and e.deleted_at is null)
           order by t.scheduled_at nulls last, t.position, t.id${forUpdate}`);
      }
      return parts;
    }
    case 'register_row': {
      const parts: RawBuilder<HeldRow>[] = [];
      for (const table of LINKED_REGISTERS) {
        const code = table === 'competence_record' ? sql`null::text` : sql`t.code`;
        const title = table === 'competence_record' ? sql`t.role_title` : sql`t.title`;
        const due = ACTION_DUE.has(table) ? sql`t.action_due_at` : sql`null::date`;
        parts.push(sql<HeldRow>`
          select ${table} as tbl, t.id, t.updated_at, ${code} as code, ${title} as title, ${due} as due_at, array['owner_user_id'] as columns,
                  ${otherLinked(table, 't', msId)} as other_ms, null as target_type
             from ${sql.table(table)} t
            where t.deleted_at is null and t.owner_user_id = ${userId}::uuid and ${linkedTo(table, 't', msId)}${forUpdate}`);
      }
      for (const table of OWNED_REGISTERS) {
        const due = ACTION_DUE.has(table) ? sql`t.action_due_at` : sql`null::date`;
        const cols = REGISTER_HOLDERS[table] ?? ['owner_user_id'];
        parts.push(sql<HeldRow>`
          select ${table} as tbl, t.id, t.updated_at, t.code, t.title, ${due} as due_at, ${columnsNaming('t', cols, userId)} as columns,
                  ${none} as other_ms, null as target_type
             from ${sql.table(table)} t
            where t.management_system_id = ${msId}::uuid and t.deleted_at is null and ${namedBy('t', cols, userId)}${forUpdate}`);
      }
      // Management reviews the person owns and that are not closed, in every system they are linked to (a joint
      // review is shared, BR-22); a planned review is due on its planned date.
      parts.push(sql<HeldRow>`
        select 'management_review' as tbl, t.id, t.updated_at, t.code, t.title, case when t.status = 'planned' then t.planned_at end as due_at,
               array['owner_user_id'] as columns, ${otherLinked('management_review', 't', msId)} as other_ms, null as target_type
          from management_review t
         where t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status <> 'closed' and ${linkedTo('management_review', 't', msId)}
         order by t.planned_at nulls last, t.code${forUpdate}`);
      // One statement per table: PostgreSQL refuses FOR UPDATE inside UNION.
      return parts;
    }
    case 'task':
      return [
        sql<HeldRow>`
        select 'task' as tbl, t.id, t.updated_at, coalesce(t.entity_code, left(t.title_en, 30)) as code, t.title_en as title, t.due_at,
               array['owner_user_id'] as columns, ${none} as other_ms, null as target_type
          from task t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.owner_user_id = ${userId}::uuid and t.status = 'open'
         order by t.due_at nulls last, t.created_at${forUpdate}`,
        // Unresolved drift results the person holds (`records.assign` kind `drift`, `holder_user_id`).
        sql<HeldRow>`
        select 'drift_result' as tbl, t.id, t.updated_at, t.entity_code as code, t.title, t.due_at,
               array['holder_user_id'] as columns, ${none} as other_ms, null as target_type
          from drift_result t
         where t.management_system_id = ${msId}::uuid and t.deleted_at is null and t.resolved_at is null and t.holder_user_id = ${userId}::uuid
         order by t.rule_code, t.position${forUpdate}`,
      ];
  }
}

/** Business code of a held record (the G.5 id of an entry, the derived code of a competence record). */
function codeOf(row: HeldRow): string {
  if (row.tbl === 'applicability_entry') return entryBusinessId(row.target_type ?? 'catalogue_item', row.code ?? '');
  if (row.tbl === 'competence_record') return competenceCode(row.id);
  return (row.code ?? row.title).slice(0, 80);
}

/** The record ref of a held record (module of the table, ETag of its version). */
function refOfHeld(row: HeldRow): RecordRef {
  return refOf(row.tbl, row.id, codeOf(row), row.updated_at);
}

@Injectable()
export class HoldingsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly rules: RuleEngine,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/holdings/{handle}
  // -------------------------------------------------------------------------------------------------------------

  async holdings(principal: Principal, ms: string, handle: string): Promise<Holdings> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const person = await this.personOf(trx, handle);
      const held = await this.heldItems(trx, system.id, person.id, HOLDING_KINDS, false);
      return {
        handle: person.handle,
        ms: system.slug,
        items: held.map((h) => ({ kind: h.kind, ref: refOfHeld(h), code: codeOf(h), title: h.title, dueAt: h.due_at })),
        counts: countsOf(held),
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/holdings/{handle}/reassign
  // -------------------------------------------------------------------------------------------------------------

  async reassign(principal: Principal, ms: string, handle: string, body: HoldingsReassign): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const person = await this.personOf(trx, handle);
      const successor = (await this.members.resolveHandle(trx, body.successor))!;
      if (successor === person.id) {
        throw new ProblemError('business-rule', {
          messageKey: 'holdings.same_person',
          messages: { en: 'Choose a successor other than the person who holds the items', id: 'Pilih penerus selain orang yang memegang item tersebut' },
          detail: 'The successor is the person who holds the items',
        });
      }
      const kinds = body.kinds ? HOLDING_KINDS.filter((k) => body.kinds!.includes(k)) : HOLDING_KINDS;
      const held = await this.heldItems(trx, system.id, person.id, kinds, true);
      // A record that two kinds hold (a document whose owner and approver is the person) moves once, with all its columns.
      const records = mergeByRecord(held);
      // BR-22: records shared with other systems change there too; the caller confirms first.
      const others = [...new Set(records.flatMap((r) => r.other_ms ?? []))].sort();
      if (others.length > 0) {
        const links = [{ msId: system.id, slug: system.slug }];
        for (const slug of others) links.push({ msId: (await this.records.resolveMs(trx, slug)).id, slug });
        await confirmShared(trx, this.rules, links, system.slug, body.confirm);
      }

      const today = todayOf(this.clock, org);
      const next = await nextAuditDate(trx, system.id, today);
      const scope = (ref: RecordRef) => ({ msIds: [system.id], ref });
      let warnings: Warning[] = [];
      for (const record of records) {
        const ref = refOfHeld(record);
        const code = codeOf(record);
        // BR-41: a due date after the next audit stays, with a warning that names the record. An audit activity is
        // left out: its due date is its own scheduled date, which may belong to a later audit event.
        if (record.tbl !== 'audit_activity') {
          warnings = mergeWarnings(warnings, asWarnings(code, await this.rules.evaluate<Br41Input>(trx, 'BR-41', { due: record.due_at, auditDate: next?.date ?? null }, scope(ref))));
        }
        // BR-16: a successor who wrote the version in review of a document they now approve cannot approve it.
        if (record.tbl === 'document' && record.columns.includes('approver_user_id')) {
          const authors = await this.authorsOf(trx, record.id);
          warnings = mergeWarnings(warnings, asWarnings(code, await this.rules.evaluate<Br16Input>(trx, 'BR-16', { actorId: successor, authors }, scope(ref))));
        }
        // BR-17: a risk keeps an owner after the handover (the successor is a member, so it always has one).
        if (record.tbl === 'risk' && this.rules.registered().includes('BR-17')) {
          warnings = mergeWarnings(warnings, asWarnings(code, await this.rules.evaluate<Br17Input>(trx, 'BR-17', { ownerUserId: successor }, scope(ref))));
        }
        // AUD-INDEP: a successor who becomes the auditor of an activity should not examine their own work (M2-05).
        if (record.tbl === 'audit_activity' && record.columns.includes('auditor_user_id') && this.rules.registered().includes('AUD-INDEP')) {
          const targetCode = await this.auditTargetOf(trx, record.id);
          if (targetCode) {
            const input: AudIndepInput = { auditorUserId: successor, auditorName: await this.nameOf(trx, successor), targetCode };
            warnings = mergeWarnings(warnings, asWarnings(code, await this.rules.evaluate<AudIndepInput>(trx, 'AUD-INDEP', input, scope(ref))));
          }
        }
        const set = record.columns.map((c) => sql`${sql.ref(c)} = ${successor}::uuid`);
        await sql`
          update ${sql.table(record.tbl)}
             set ${sql.join([...set, sql`updated_by = ${actor}::uuid`, sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')`])}
           where id = ${record.id}`.execute(trx);
        await this.audit.record(trx, {
          action: 'holdings.reassigned',
          msId: system.id,
          entityType: record.tbl,
          entityId: record.id,
          entityCode: codeOf(record),
          before: { holder: person.handle },
          after: { holder: body.successor, columns: record.columns, kinds: record.kinds },
        });
      }
      const counts = countsOf(held);
      return commandResult([system.slug, ...others], {
        count: records.length,
        warnings,
        message: [
          `${records.length} items moved from ${person.handle} to ${body.successor}`,
          `${records.length} item dipindahkan dari ${person.handle} ke ${body.successor}`,
        ],
        data: { counts },
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /admin/users/{id}/holdings
  // -------------------------------------------------------------------------------------------------------------

  /** Counts per system and kind, with the primary manager of each system; systems where the person holds nothing are left out. */
  async userHoldings(principal: Principal, userId: string): Promise<UserHoldings> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const { rows: members } = await sql<{ id: string }>`
        select u.id from platform.org_membership m join platform.app_user u on u.id = m.user_id
         where m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid and m.deleted_at is null and u.id = ${userId}::uuid`.execute(trx);
      if (!members[0]) throw new NotFoundError();
      const { rows: systems } = await sql<{ id: string; slug: string; name: string; m_handle: string | null; m_name: string | null; m_email: string | null }>`
        select ms.id, ms.slug, ms.name, u.handle as m_handle, u.display_name as m_name, u.email as m_email
          from management_system ms
          left join user_ms_role r on r.management_system_id = ms.id and r.role = 'ms_manager' and r.is_primary and r.deleted_at is null
                                  and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > now())
          left join platform.app_user u on u.id = r.user_id
         where ms.deleted_at is null
         order by ms.position, ms.slug`.execute(trx);
      const out: UserHoldings['systems'] = [];
      for (const system of systems) {
        const held = await this.heldItems(trx, system.id, userId, HOLDING_KINDS, false);
        if (held.length === 0) continue;
        out.push({
          ms: system.slug,
          name: system.name,
          primaryManager: system.m_handle ? { handle: system.m_handle, displayName: system.m_name ?? system.m_handle, email: system.m_email ?? '' } : null,
          counts: countsOf(held),
          total: held.length,
        });
      }
      return { systems: out };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** A member of the organisation (any membership state, so a person who left can still be handed over); 404 otherwise. */
  private async personOf(trx: Trx, handle: string): Promise<{ id: string; handle: string }> {
    const { rows } = await sql<{ id: string; handle: string }>`
      select u.id, u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
       where m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid and m.deleted_at is null and u.handle = ${handle}`.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError(`${handle} is not a member of this organisation`);
    return row;
  }

  /** The person's open items of the kinds in a system, kind by kind (`lock`: locked for a handover). */
  private async heldItems(trx: Trx, msId: string, userId: string, kinds: readonly HoldingKind[], lock: boolean): Promise<Held[]> {
    const out: Held[] = [];
    for (const kind of kinds) {
      for (const query of heldQueries(kind, msId, userId, lock)) {
        const { rows } = await query.execute(trx);
        for (const row of rows) out.push({ ...row, columns: row.columns ?? [], kind });
      }
    }
    return out;
  }

  /** The clause or control code an audit activity examines (AUD-INDEP), null when none is set. */
  private async auditTargetOf(trx: Trx, activityId: string): Promise<string | null> {
    const { rows } = await sql<{ target_code: string | null }>`select target_code from audit_activity where id = ${activityId}`.execute(trx);
    return rows[0]?.target_code ?? null;
  }

  /** The display name of a person (the AUD-INDEP warning names the auditor). */
  private async nameOf(trx: Trx, userId: string): Promise<string> {
    const { rows } = await sql<{ display_name: string }>`select display_name from platform.app_user where id = ${userId}`.execute(trx);
    return rows[0]?.display_name ?? '';
  }

  /** BR-16 authors of a document: the submitter of the version in review, else of the current version, else its creator. */
  private async authorsOf(trx: Trx, documentId: string): Promise<(string | null)[]> {
    const { rows } = await sql<{ author: string | null }>`
      select coalesce(
        (select v.submitted_by from document_version v where v.document_id = d.id and v.status = 'in_review' and v.deleted_at is null
          order by v.created_at desc limit 1),
        (select v.submitted_by from document_version v where v.id = d.current_version_id),
        d.created_by) as author
        from document d where d.id = ${documentId}`.execute(trx);
    return [rows[0]?.author ?? null];
  }
}

/** Counts per kind of a list of held items (kinds without items are left out). */
function countsOf(held: readonly Pick<Held, 'kind'>[]): Partial<Record<HoldingKind, number>> {
  const counts: Partial<Record<HoldingKind, number>> = {};
  for (const h of held) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return counts;
}

/** One entry per record with every holder column and kind that names the person. */
function mergeByRecord(held: readonly Held[]): (HeldRow & { kinds: HoldingKind[] })[] {
  const byRecord = new Map<string, HeldRow & { kinds: HoldingKind[] }>();
  for (const h of held) {
    const key = `${h.tbl}:${h.id}`;
    const existing = byRecord.get(key);
    if (existing) {
      existing.columns = [...new Set([...existing.columns, ...h.columns])];
      existing.kinds.push(h.kind);
    } else {
      const { kind, ...row } = h;
      byRecord.set(key, { ...row, kinds: [kind] });
    }
  }
  return [...byRecord.values()];
}

/**
 * Findings of a rule for one record as D.1 warnings that start with the record's code, so each record keeps its own
 * warning (a handover moves the record and names what the rule found).
 */
function asWarnings(code: string, findings: readonly RuleFinding[]): Warning[] {
  return findings.map((f) => ({ rule: f.rule, messages: { en: `${code}: ${f.messages.en}`, id: `${code}: ${f.messages.id}` } }));
}
