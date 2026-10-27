// Certification cycle steps shared by the certification routes, the audit event commands and the `certificate.expiry`
// job (Milestone 2 D.4, J.8): the open cycle of a system, starting a cycle (insert an active one, or activate the
// planned one) with its cycle items and the events that belong to it, and the certificate label of the read model,
// which follows the newest cycle that holds a certificate. Every step runs in the caller's tenant transaction.
import type { Pair } from '@mscd/shared';
import { sql } from 'kysely';
import { addDays } from '../../common/dates';
import { ConflictError } from '../../common/problems';
import type { AuditWriter, Trx } from '../../common/tokens';
import { certificateLabelOf } from '../read-model/derive/ms-fields';

/** Statuses of an open cycle: at most one per system (unique index `certification_cycle_open_uq`, D.3). */
export const OPEN_CYCLE_STATUSES = ['planned', 'active'] as const;

/** Statuses of a cycle that holds a certificate, newest first decides the certificate label (D.4). */
export const CERTIFICATE_STATUSES = ['certified', 'suspended', 'withdrawn', 'expired'] as const;

/** Event types whose first event opens a cycle when the system has none open (D.4). */
export const CYCLE_OPENING_EVENTS: ReadonlySet<string> = new Set(['stage1', 'recertification']);

/** Outcomes of a stage2 or recertification audit that allow the certificate to be recorded (D.4). */
export const RECOMMENDED_OUTCOMES: ReadonlySet<string> = new Set(['recommended', 'recommended_with_conditions']);

/** Days before `certificate_expires_at` on which MS Managers and Programme Owners get `certificate_expiring` (D.4). */
export const EXPIRY_NOTICE_DAYS = [90, 30, 7] as const;

/** A certification cycle row as these steps read it. */
export interface CycleRow {
  id: string;
  management_system_id: string;
  status: 'planned' | 'active' | 'certified' | 'suspended' | 'withdrawn' | 'expired' | 'closed';
  cycle_start: string;
  cycle_end: string;
  certified_at: string | null;
  certificate_no: string | null;
  certificate_expires_at: string | null;
  certification_body: string | null;
  certified_scope: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The system a cycle step works on. */
export interface CycleSystem {
  id: string;
  slug: string;
  frameworkVersionId: string;
}

/** `cycleStart` plus three years (D.4 default of `cycleEnd`), the same month and day; 29 February becomes 28 February. */
export function threeYearsAfter(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const target = `${String(year + 3).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // 29 February of a year whose third successor is not a leap year.
  if (month === 2 && day === 29 && !isLeap(year + 3)) return `${String(year + 3).padStart(4, '0')}-02-28`;
  return target;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The certificate label of the read model (G.5 `MS.cert`) for a cycle that holds a certificate (`certificateLabelOf` of
 * the read model's card fields, D.4); null for any other cycle.
 */
export function certificateLabel(cycle: Pick<CycleRow, 'status' | 'certified_at' | 'certificate_expires_at' | 'cycle_start' | 'cycle_end'>): Pair | null {
  return certificateLabelOf({
    status: cycle.status, cycleStart: cycle.cycle_start, cycleEnd: cycle.cycle_end, certifiedAt: cycle.certified_at, certificateExpiresAt: cycle.certificate_expires_at,
  });
}

const CYCLE_COLUMNS = sql`c.id, c.management_system_id, c.status, c.cycle_start, c.cycle_end, c.certified_at, c.certificate_no,
  c.certificate_expires_at, c.certification_body, c.certified_scope, c.created_at, c.updated_at`;

/** The open cycle (`planned` or `active`) of a system, locked for update when asked; undefined when there is none. */
export async function openCycleOf(trx: Trx, msId: string, forUpdate = false): Promise<CycleRow | undefined> {
  const { rows } = await sql<CycleRow>`
    select ${CYCLE_COLUMNS} from certification_cycle c
     where c.management_system_id = ${msId} and c.deleted_at is null and c.status in ('planned', 'active')
     order by c.cycle_start desc, c.created_at desc limit 1
     ${forUpdate ? sql`for update` : sql``}`.execute(trx);
  return rows[0];
}

/** A cycle of the system by id, locked for update; undefined when the id names no live cycle of this system. */
export async function cycleOf(trx: Trx, msId: string, id: string, forUpdate = false): Promise<CycleRow | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const { rows } = await sql<CycleRow>`
    select ${CYCLE_COLUMNS} from certification_cycle c
     where c.id = ${id} and c.management_system_id = ${msId} and c.deleted_at is null
     ${forUpdate ? sql`for update` : sql``}`.execute(trx);
  return rows[0];
}

/** Moves a cycle to a status (and sets more columns), with a new `updated_at`; returns the new value. */
export async function setCycle(trx: Trx, id: string, set: Record<string, unknown>, actor: string): Promise<Date> {
  const assignments = Object.entries(set).map(([column, value]) => sql`${sql.ref(column)} = ${value}`);
  const { rows } = await sql<{ updated_at: Date }>`
    update certification_cycle
       set ${sql.join([...assignments, sql`updated_by = ${actor}`, sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')`])}
     where id = ${id}
    returning updated_at`.execute(trx);
  return new Date(rows[0]!.updated_at);
}

/**
 * Writes the certificate label of the newest cycle that holds a certificate into `management_system.display.certLabel`
 * (the stored display value the read model shows, G.4), so the label follows certification, suspension,
 * reinstatement, withdrawal, expiry and recertification (D.4). A system that never held a certificate keeps its label.
 * Returns the label written, or null when nothing was written.
 */
export async function refreshCertificateLabel(trx: Trx, msId: string): Promise<Pair | null> {
  const { rows } = await sql<CycleRow>`
    select ${CYCLE_COLUMNS} from certification_cycle c
     where c.management_system_id = ${msId} and c.deleted_at is null and c.status in ('certified', 'suspended', 'withdrawn', 'expired')
     order by coalesce(c.certified_at, c.cycle_start) desc, c.cycle_start desc, c.created_at desc limit 1`.execute(trx);
  const label = rows[0] ? certificateLabel(rows[0]) : null;
  if (!label) return null;
  await sql`update management_system
               set display = jsonb_set(coalesce(display, '{}'::jsonb), '{certLabel}', ${JSON.stringify(label)}::jsonb),
                   updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
             where id = ${msId} and (display -> 'certLabel') is distinct from ${JSON.stringify(label)}::jsonb`.execute(trx);
  return label;
}

/** How a cycle start was asked for: the route `ms.cycles.create`, or the first opening audit event (D.4). */
export type CycleTrigger = { kind: 'route' } | { kind: 'audit_event'; eventId: string; eventType: string; shortLabel: string };

export interface StartCycleInput {
  system: CycleSystem;
  /** Dates of a new cycle; for the activation of a planned cycle only when `keepPlannedDates` is false. */
  cycleStart: string;
  cycleEnd: string;
  /** Activation of a planned cycle by an audit event keeps the planned dates (D.4). */
  keepPlannedDates: boolean;
  today: string;
  actor: string;
  trigger: CycleTrigger;
}

export interface StartedCycle {
  cycleId: string;
  /** True when a planned cycle was activated; false when a new cycle was inserted. */
  activated: boolean;
  cycleStart: string;
  cycleEnd: string;
  /** Codes of the cycle requirement definitions copied into cycle items. */
  items: string[];
  /** Events of the system now linked to the cycle (they had no cycle). */
  linkedEvents: number;
  updatedAt: Date;
}

/**
 * Starts the certification cycle of a system (D.4, J.8): activates its `planned` cycle, or inserts a new `active`
 * cycle when it has no open one; copies the edition's cycle requirement definitions into cycle items (owner the
 * primary MS Manager, due the day before the next audit event of the cycle, else at the cycle end); links the
 * system's events that have no cycle; audits `certification_cycle.created`. An `active` cycle answers 409.
 */
export async function startCycle(trx: Trx, audit: AuditWriter, input: StartCycleInput): Promise<StartedCycle> {
  const { system, actor, trigger } = input;
  const open = await openCycleOf(trx, system.id, true);
  if (open?.status === 'active') {
    throw new ConflictError('The system already has an open certification cycle', { messageKey: 'certification.cycle_open' });
  }
  let cycleId: string;
  let cycleStart = input.cycleStart;
  let cycleEnd = input.cycleEnd;
  let updatedAt: Date;
  if (open) {
    if (input.keepPlannedDates) {
      cycleStart = open.cycle_start;
      cycleEnd = open.cycle_end;
    }
    cycleId = open.id;
    updatedAt = await setCycle(trx, open.id, { status: 'active', cycle_start: cycleStart, cycle_end: cycleEnd }, actor);
  } else {
    try {
      const { rows } = await sql<{ id: string; updated_at: Date }>`
        insert into certification_cycle (management_system_id, cycle_start, cycle_end, status, created_by, updated_by)
        values (${system.id}, ${cycleStart}::date, ${cycleEnd}::date, 'active', ${actor}, ${actor})
        returning id, updated_at`.execute(trx);
      cycleId = rows[0]!.id;
      updatedAt = new Date(rows[0]!.updated_at);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new ConflictError('The system already has an open certification cycle', { messageKey: 'certification.cycle_open' });
      }
      throw error;
    }
  }
  // The link is bookkeeping of the cycle, not a change of the event, so the events keep their version (ETag).
  const linked = await sql`
    update audit_event set certification_cycle_id = ${cycleId}
     where management_system_id = ${system.id} and deleted_at is null and certification_cycle_id is null`.execute(trx);
  const items = await copyCycleItems(trx, system, cycleId, cycleEnd, input.today, actor);
  await audit.record(trx, {
    action: 'certification_cycle.created',
    msId: system.id,
    entityType: 'certification_cycle',
    entityId: cycleId,
    entityCode: `${cycleStart}/${cycleEnd}`,
    ...(open ? { before: { status: 'planned', cycle_start: open.cycle_start, cycle_end: open.cycle_end } } : {}),
    after: {
      status: 'active',
      cycle_start: cycleStart,
      cycle_end: cycleEnd,
      ...(open ? { activated: true } : {}),
      cycle_items: items,
      ...(trigger.kind === 'audit_event' ? { audit_event: trigger.shortLabel, event_type: trigger.eventType } : {}),
    },
  });
  return { cycleId, activated: !!open, cycleStart, cycleEnd, items, linkedEvents: Number(linked.numAffectedRows ?? 0), updatedAt };
}

/**
 * Cycle items for every cycle requirement definition of the system's edition that the cycle has never held (an item
 * the team removed is not added again): owner the primary MS Manager, due the day before the next audit event of the
 * cycle from today (never before today), else at the cycle end. Returns the codes added.
 */
export async function copyCycleItems(trx: Trx, system: CycleSystem, cycleId: string, cycleEnd: string, today: string, actor: string): Promise<string[]> {
  const { rows: defs } = await sql<{ id: string; code: string; requirement_code: string | null; title: string }>`
    select d.id, d.code, d.requirement_code, d.title from ref.cycle_requirement_def d
     where d.framework_version_id = ${system.frameworkVersionId}
       and not exists (select 1 from cycle_requirement_status s where s.certification_cycle_id = ${cycleId} and s.cycle_requirement_def_id = d.id)
     order by d.sort_order, d.code`.execute(trx);
  if (defs.length === 0) return [];
  const { rows: owners } = await sql<{ user_id: string }>`
    select user_id from user_ms_role
     where management_system_id = ${system.id} and role = 'ms_manager' and is_primary and approval_status = 'active' and deleted_at is null
     limit 1`.execute(trx);
  const { rows: next } = await sql<{ due: string | null }>`
    select min(scheduled_at)::text as due from audit_event
     where management_system_id = ${system.id} and deleted_at is null and certification_cycle_id = ${cycleId} and scheduled_at > ${today}::date`.execute(trx);
  const due = next[0]?.due ? maxIso(addDays(next[0].due, -1), today) : cycleEnd;
  const { rows: position } = await sql<{ next: number }>`
    select coalesce(max(position), -1)::int + 1 as next from cycle_requirement_status where management_system_id = ${system.id}`.execute(trx);
  let at = position[0]?.next ?? 0;
  await trx
    .insertInto('cycle_requirement_status')
    .values(
      defs.map((d) => ({
        management_system_id: system.id,
        certification_cycle_id: cycleId,
        cycle_requirement_def_id: d.id,
        requirement_code: d.requirement_code ?? '-',
        title: d.title,
        owner_user_id: owners[0]?.user_id ?? null,
        status: 'not_started' as const,
        due_at: due,
        position: at++,
        created_by: actor,
        updated_by: actor,
      })),
    )
    .execute();
  return defs.map((d) => d.code);
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}
