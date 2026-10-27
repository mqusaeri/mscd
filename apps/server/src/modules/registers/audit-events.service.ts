// Audit event, preparation task and cycle item commands of D.3 (WP-35, TS 6.7 and 6.8, C.13, A-23, A-26): plan and
// change an audit event (moving its date recomputes the After audit flags and the BR-43 flags of its preparation
// tasks and notifies the holders whose items now fall after the audit, BR-42), add and update preparation tasks
// (due before the audit, BR-43; status per C.13, blocked needs a note) and update cycle items (status per C.13).
// Milestone 2 (D.2, D.4, M2-05): internal audits with their scope text and report (a document of type record of the
// system), planned by MS Managers and Internal Auditors; an Internal Auditor without `audit_event.manage` changes
// internal audits only and never turns one into another event type; the first `stage1` or `recertification` event of
// a system without an open cycle starts the certification cycle (or activates the planned one with a `stage1`
// event); an internal audit with a report queues `cycle.derive` (`internal_audit_done`).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditEventCreateRequest, type AuditEventPatch, type CommandResult, type CycleItemPatch, type MachineEntity, type Permission,
  type PrepTaskCreate, type PrepTaskPatch, type RecordRef, type UiMsSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch } from '../../common/etag';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { ForbiddenError, NotFoundError, ProblemError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import { currentRequestId } from '../../common/request-context';
import {
  AUDIT_WRITER, MEMBERSHIP_SERVICE, NOTIFICATION_WRITER, PERMISSION_EVALUATOR, RECORD_RESOLVER, type AuditWriter, type AuthzState, type MembershipService,
  type MsRef, type NotificationWriter, type PermissionEvaluator, type Principal, type RecordResolver, type Trx,
} from '../../common/tokens';
import { cycleDeriveKey } from '../audit-registers/cycle-derive.service';
import { CYCLE_OPENING_EVENTS, openCycleOf, startCycle, threeYearsAfter, type StartedCycle } from '../management-systems/certification.cycles';
import { ReadModelService } from '../read-model';
import { RuleEngine, ruleMessages } from '../rules';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  assertOwnScope, assertRequires, commandResult, isBr43TriggerError, orgOf, personOf, pickTransition, refOf, todayOf, unprocessable, writeRow,
} from './command-support';
import type { Br42Input, Br43Input } from './register.rules';

const EVENT = 'audit_event';
const PREP = 'audit_prep_task';
const CYCLE = 'cycle_requirement_status';

interface EventRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  event_type: string;
  name_en: string;
  name_id: string;
  short_label: string;
  scheduled_at: string;
  audit_days: number | null;
  lead_auditor_name: string | null;
  expected_focus: string | null;
  prep_window_days: number;
  outcome: string | null;
  outcome_summary: string | null;
  scope_text: string | null;
  report_document_id: string | null;
  certification_cycle_id: string | null;
}

/** Request members of `AuditEventPatch` and their columns. */
const EVENT_FIELDS: readonly [keyof AuditEventPatch, keyof EventRow][] = [
  ['eventType', 'event_type'],
  ['nameEn', 'name_en'],
  ['nameId', 'name_id'],
  ['shortLabel', 'short_label'],
  ['scheduledAt', 'scheduled_at'],
  ['auditDays', 'audit_days'],
  ['leadAuditorName', 'lead_auditor_name'],
  ['expectedFocus', 'expected_focus'],
  ['prepWindowDays', 'prep_window_days'],
  ['outcome', 'outcome'],
  ['outcomeSummary', 'outcome_summary'],
  ['scopeText', 'scope_text'],
  ['reportDocumentId', 'report_document_id'],
];

/** A preparation task or cycle item as the progress commands read it. */
interface ProgressRow {
  id: string;
  management_system_id: string;
  updated_at: Date;
  title: string;
  owner_user_id: string | null;
  due_at: string;
  status: string;
  note?: string | null;
  condition_note?: string | null;
  audit_event_id?: string;
  requirement_code?: string;
}

/** How one progress table is patched (preparation tasks and cycle items share the C.13 machine shape). */
interface ProgressKind {
  table: typeof PREP | typeof CYCLE;
  machine: MachineEntity;
  permission: Permission;
  noteColumn: 'note' | 'condition_note';
  action: 'prep_task.updated' | 'cycle_item.updated';
}

const PROGRESS: Readonly<Record<'prep' | 'cycle', ProgressKind>> = {
  prep: { table: PREP, machine: 'audit_prep_task.status', permission: 'prep_task.update', noteColumn: 'note', action: 'prep_task.updated' },
  cycle: { table: CYCLE, machine: 'cycle_requirement_status.status', permission: 'cycle_item.update', noteColumn: 'condition_note', action: 'cycle_item.updated' },
};

function br43Problem(): ProblemError {
  const messages = ruleMessages('BR-43');
  return new ProblemError('business-rule', { rule: 'BR-43', messages, detail: messages.en, messageKey: 'rule.BR-43' });
}

@Injectable()
export class AuditEventCommandsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly rules: RuleEngine,
    private readonly readModel: ReadModelService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(MEMBERSHIP_SERVICE) private readonly members: MembershipService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    private readonly clock: Clock,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/audit-events
  // -------------------------------------------------------------------------------------------------------------

  async createEvent(principal: Principal, ms: string, body: AuditEventCreateRequest): Promise<CommandResult> {
    const actor = principal.user.id;
    const today = todayOf(this.clock, orgOf(principal));
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      if (body.reportDocumentId) await this.assertReport(trx, system, body.reportDocumentId);
      // D.4: the first stage1 or recertification event of a system without an open cycle starts one (a stage1 event
      // activates the planned cycle); the cycle step links this event, which is inserted without a cycle first.
      const opens = await this.opensCycle(trx, system, body.eventType);
      const cycle = opens
        ? null
        : await sql<{ id: string }>`
            select id from certification_cycle where management_system_id = ${system.id} and deleted_at is null
             order by (status in ('active', 'planned', 'certified')) desc, cycle_start desc limit 1`.execute(trx);
      const id = randomUUID();
      const { rows } = await sql<{ updated_at: Date }>`
        insert into audit_event (id, management_system_id, certification_cycle_id, event_type, name_en, name_id, short_label, scheduled_at,
                                 audit_days, lead_auditor_name, expected_focus, prep_window_days, scope_text, report_document_id, created_by, updated_by)
        values (${id}, ${system.id}, ${cycle?.rows[0]?.id ?? null}, ${body.eventType}, ${body.nameEn}, ${body.nameId}, ${body.shortLabel},
                ${body.scheduledAt}::date, ${body.auditDays ?? null}, ${body.leadAuditorName ?? null}, ${body.expectedFocus ?? null},
                ${body.prepWindowDays ?? 60}, ${body.scopeText ?? null}, ${body.reportDocumentId ?? null}, ${actor}, ${actor})
        returning updated_at`.execute(trx);
      // Audit events are shareable (C.6): the path system holds the primary link.
      await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
                values ('audit_event', ${id}, ${system.id}, true, ${actor}, ${actor})`.execute(trx);
      await this.audit.record(trx, {
        action: 'audit_event.created',
        msId: system.id,
        entityType: EVENT,
        entityId: id,
        entityCode: body.shortLabel,
        after: {
          event_type: body.eventType,
          name_en: body.nameEn,
          scheduled_at: body.scheduledAt,
          ...(body.auditDays !== undefined ? { audit_days: body.auditDays } : {}),
          prep_window_days: body.prepWindowDays ?? 60,
          ...(body.scopeText ? { scope_text: body.scopeText } : {}),
          ...(body.reportDocumentId ? { report_document_id: body.reportDocumentId } : {}),
        },
      });
      const started = opens ? await this.startCycleFor(trx, system, { id, eventType: body.eventType, shortLabel: body.shortLabel, scheduledAt: body.scheduledAt }, today, actor) : null;
      if (body.eventType === 'internal_audit' && body.reportDocumentId) await this.queueDerive(trx, principal, system.id);
      return commandResult([system.slug], {
        ref: refOf(EVENT, id, body.shortLabel, rows[0]!.updated_at),
        ...(started ? { message: cycleMessage(started), data: { cycle: { id: started.cycleId, activated: started.activated, items: started.items } } } : {}),
      });
    });
  }

  /**
   * True when an event of `eventType` starts the certification cycle of the system now (D.4): a stage1 or
   * recertification event and no open cycle, or a stage1 event and a planned cycle.
   */
  private async opensCycle(trx: Trx, system: MsRef, eventType: string): Promise<boolean> {
    if (!CYCLE_OPENING_EVENTS.has(eventType)) return false;
    const open = await openCycleOf(trx, system.id, true);
    return !open || (open.status === 'planned' && eventType === 'stage1');
  }

  /** Starts the cycle for an opening event: from the earlier of today and the event date, for three years (D.4). */
  private async startCycleFor(
    trx: Trx,
    system: MsRef,
    event: { id: string; eventType: string; shortLabel: string; scheduledAt: string },
    today: string,
    actor: string,
  ): Promise<StartedCycle> {
    const { rows } = await sql<{ framework_version_id: string }>`select framework_version_id from management_system where id = ${system.id}`.execute(trx);
    const cycleStart = event.scheduledAt < today ? event.scheduledAt : today;
    return startCycle(trx, this.audit, {
      system: { id: system.id, slug: system.slug, frameworkVersionId: rows[0]!.framework_version_id },
      cycleStart,
      cycleEnd: threeYearsAfter(cycleStart),
      keepPlannedDates: true,
      today,
      actor,
      trigger: { kind: 'audit_event', eventId: event.id, eventType: event.eventType, shortLabel: event.shortLabel },
    });
  }

  /**
   * The audit report of an event (D.2): a live document of type record that belongs to the system (its own, shared
   * with it, or organisation-wide); 404 for an unknown document, 422 for another document type.
   */
  private async assertReport(trx: Trx, system: MsRef, documentId: string): Promise<void> {
    const { rows } = await sql<{ doc_code: string; doc_type: string }>`
      select d.doc_code, d.doc_type from document d
       where d.id = ${documentId} and d.deleted_at is null
         and (d.is_org_wide or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = d.id
                                         and l.management_system_id = ${system.id} and l.deleted_at is null))`.execute(trx);
    const doc = rows[0];
    if (!doc) throw new NotFoundError('Unknown document');
    if (doc.doc_type !== 'record') {
      throw unprocessable(
        'audit.report_not_record',
        `${doc.doc_code} is not a record; the audit report is a document of type record`,
        `${doc.doc_code} bukan rekaman; laporan audit adalah dokumen bertipe rekaman`,
      );
    }
  }

  /** Queues `cycle.derive` for a system in the command's transaction (D.4 `internal_audit_done`). */
  private async queueDerive(trx: Trx, principal: Principal, msId: string): Promise<void> {
    const org = orgOf(principal);
    await this.jobs.send(
      'cycle.derive',
      { orgId: org.id, requestId: currentRequestId(), requestedBy: principal.user.id, payload: { msId } },
      { singletonKey: cycleDeriveKey(org.id, msId), startAfterSeconds: 60, retryLimit: 3 },
      trx,
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/audit-events/{id}
  // -------------------------------------------------------------------------------------------------------------

  async updateEvent(principal: Principal, ms: string, id: string, patch: AuditEventPatch, ifMatch: string | undefined): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    // Milestone 2 D.2: the guard also admits holders of internal_audit.manage. Without audit_event.manage the caller
    // may change internal audits only, and keeps them internal audits (M2-05 builds the rest of the rule).
    const managesEvents = (await this.evaluator.evaluate(principal, 'audit_event.manage', { scope: 'ms', ms })) !== null;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await this.event(trx, system, id);
      if (!managesEvents && (event.event_type !== 'internal_audit' || (patch.eventType !== undefined && patch.eventType !== 'internal_audit'))) {
        throw new ForbiddenError('You can change internal audits only, and you cannot change their event type');
      }
      const currentRef = refOf(EVENT, id, event.short_label, event.updated_at);
      assertIfMatch(ifMatch, event.updated_at, currentRef);
      if (patch.reportDocumentId && patch.reportDocumentId !== event.report_document_id) await this.assertReport(trx, system, patch.reportDocumentId);
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [member, column] of EVENT_FIELDS) {
        const value = patch[member];
        if (value === undefined || (event[column] ?? null) === (value ?? null)) continue;
        set[column] = value;
        before[column] = event[column] ?? null;
        after[column] = value;
      }
      if (set.prep_window_days === null) set.prep_window_days = 60;
      const dateMoved = set.scheduled_at !== undefined;
      // BR-42 needs the After audit flags before the change.
      const flagsBefore = dateMoved ? afterFlags(await this.readModel.systemSnapshotIn(trx, org, ms)) : null;
      const updatedAt = await writeRow(trx, EVENT, id, set, actor);
      let notified = 0;
      if (dateMoved) {
        const newDate = set.scheduled_at as string;
        // A-26: preparation tasks now on or after the audit are flagged, never rejected.
        const { rows: flagged } = await sql<{ owner_user_id: string | null; was: boolean; now: boolean }>`
          update audit_prep_task p set violates_br43 = (p.due_at >= ${newDate}::date)
            from (select id, violates_br43 as was from audit_prep_task where audit_event_id = ${id} and deleted_at is null) old
           where p.id = old.id
          returning p.owner_user_id, old.was, p.violates_br43 as now`.execute(trx);
        const flagsAfter = afterFlags(await this.readModel.systemSnapshotIn(trx, org, ms));
        const counts = new Map<string, number>();
        for (const [key, item] of flagsAfter) {
          if (!item.after || item.holder === 'none' || flagsBefore!.get(key)?.after) continue;
          const userId = await this.userIdOf(trx, item.holder);
          if (userId) counts.set(userId, (counts.get(userId) ?? 0) + 1);
        }
        for (const p of flagged) {
          if (p.now && !p.was && p.owner_user_id) counts.set(p.owner_user_id, (counts.get(p.owner_user_id) ?? 0) + 1);
        }
        for (const [userId, count] of counts) {
          const [finding] = await this.rules.evaluate<Br42Input>(trx, 'BR-42', { count }, { msIds: [system.id], ref: refOf(EVENT, id, event.short_label, updatedAt) });
          if (!finding) continue;
          const created = await this.notifications.create(trx, {
            recipientUserId: userId,
            kind: 'audit_date_changed',
            title: { en: `Audit date changed: ${event.name_en}`, id: `Tanggal audit berubah: ${event.name_id}` },
            body: finding.messages,
            msId: system.id,
            ref: refOf(EVENT, id, event.short_label, updatedAt),
          });
          if (created) notified += 1;
        }
        after.holders_notified = notified;
      }
      if (Object.keys(set).length > 0) {
        await this.audit.record(trx, { action: 'audit_event.updated', msId: system.id, entityType: EVENT, entityId: id, entityCode: event.short_label, before, after });
      }
      // D.4: an event changed into the first stage1 or recertification event of a system without an open cycle starts it.
      const typeChanged = set.event_type !== undefined;
      const started = typeChanged && (await this.opensCycle(trx, system, set.event_type as string))
        ? await this.startCycleFor(trx, system, {
            id, eventType: set.event_type as string, shortLabel: (set.short_label as string | undefined) ?? event.short_label,
            scheduledAt: (set.scheduled_at as string | undefined) ?? event.scheduled_at,
          }, todayOf(this.clock, org), actor)
        : null;
      if (started && event.certification_cycle_id !== null) {
        await sql`update audit_event set certification_cycle_id = ${started.cycleId} where id = ${id}`.execute(trx);
      }
      const eventType = (set.event_type as string | undefined) ?? event.event_type;
      const report = 'report_document_id' in set ? (set.report_document_id as string | null) : event.report_document_id;
      if (eventType === 'internal_audit' && report && ('report_document_id' in set || typeChanged)) await this.queueDerive(trx, principal, system.id);
      return {
        ...commandResult([system.slug], {
          ref: refOf(EVENT, id, event.short_label, updatedAt),
          ...(started ? { message: cycleMessage(started), data: { cycle: { id: started.cycleId, activated: started.activated, items: started.items } } } : {}),
        }),
        count: notified,
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/audit-events/{id}/prep-tasks
  // -------------------------------------------------------------------------------------------------------------

  async createPrepTask(principal: Principal, ms: string, eventId: string, body: PrepTaskCreate): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const event = await this.event(trx, system, eventId);
      const ref: RecordRef = refOf(EVENT, eventId, event.short_label, event.updated_at);
      await this.rules.enforce<Br43Input>(trx, 'BR-43', { due: body.dueAt, auditDate: event.scheduled_at }, { msIds: [system.id], ref });
      const status = body.status ?? 'not_started';
      if (status === 'overdue') throw new TransitionNotAllowedError(null, status);
      if (status === 'blocked' && !body.note) throw new ValidationError([{ path: 'body.note', message: 'A blocked task needs a note' }]);
      const owner = await this.members.resolveHandle(trx, body.ownerHandle);
      const id = randomUUID();
      let updatedAt: Date;
      try {
        const { rows } = await sql<{ updated_at: Date }>`
          insert into audit_prep_task (id, audit_event_id, management_system_id, title, owner_user_id, due_at, status, note, position, created_by, updated_by)
          values (${id}, ${eventId}, ${system.id}, ${body.title}, ${owner}, ${body.dueAt}::date, ${status}, ${body.note ?? null},
                  (select coalesce(max(position), -1) + 1 from audit_prep_task where audit_event_id = ${eventId}), ${actor}, ${actor})
          returning updated_at`.execute(trx);
        updatedAt = rows[0]!.updated_at;
      } catch (error) {
        if (isBr43TriggerError(error)) throw br43Problem();
        throw error;
      }
      const taskRef = refOf(PREP, id, body.title, updatedAt);
      await this.audit.record(trx, {
        action: 'prep_task.updated',
        msId: system.id,
        entityType: PREP,
        entityId: id,
        entityCode: body.title,
        after: { created: true, audit_event: event.short_label, title: body.title, owner: body.ownerHandle, due_at: body.dueAt, status, ...(body.note ? { note: body.note } : {}) },
      });
      if (owner) await this.notifyPrepAssigned(trx, owner, system, taskRef, body.dueAt);
      return commandResult([system.slug], { ref: taskRef });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PATCH /ms/{ms}/prep-tasks/{id} and PATCH /ms/{ms}/cycle-items/{id}
  // -------------------------------------------------------------------------------------------------------------

  updatePrepTask(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: PrepTaskPatch, ifMatch: string | undefined): Promise<CommandResult> {
    return this.updateProgress(PROGRESS.prep, principal, authz, ms, id, patch, ifMatch);
  }

  updateCycleItem(principal: Principal, authz: AuthzState | null, ms: string, id: string, patch: CycleItemPatch, ifMatch: string | undefined): Promise<CommandResult> {
    return this.updateProgress(PROGRESS.cycle, principal, authz, ms, id, patch, ifMatch);
  }

  private updateProgress(
    kind: ProgressKind,
    principal: Principal,
    authz: AuthzState | null,
    ms: string,
    id: string,
    patch: PrepTaskPatch | CycleItemPatch,
    ifMatch: string | undefined,
  ): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.records.resolve(trx, ms, kind.table, id, { forUpdate: true });
      const row = record.row as unknown as ProgressRow;
      const code = kind.table === PREP ? row.title : row.requirement_code!;
      const currentRef = refOf(kind.table, id, code, row.updated_at);
      assertIfMatch(ifMatch, row.updated_at, currentRef);
      const owns = row.owner_user_id === actor;
      const set: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (column: string, value: unknown, shown?: { before: unknown; after: unknown }) => {
        const current = (row as unknown as Record<string, unknown>)[column] ?? null;
        if (current === (value ?? null)) return;
        set[column] = value ?? null;
        before[column] = shown ? shown.before : current;
        after[column] = shown ? shown.after : (value ?? null);
      };

      const note = patch.note !== undefined ? patch.note : (row[kind.noteColumn] ?? null);
      if (patch.status !== undefined && patch.status !== row.status) {
        const transition = pickTransition(kind.machine, row.status, patch.status, authz, owns);
        assertRequires(transition, { note: note ?? undefined });
        change('status', patch.status);
      } else {
        // Field changes without a status change need the permission too (own grants: only the holder).
        assertOwnScope(authz, kind.permission, [row.owner_user_id], actor);
      }
      const status = (set.status as string | undefined) ?? row.status;
      if (patch.note !== undefined) {
        if (patch.note === null && status === 'blocked') throw new ValidationError([{ path: 'body.note', message: 'A blocked item needs a note' }]);
        change(kind.noteColumn, patch.note);
      }
      if ('title' in patch && patch.title !== undefined) change('title', patch.title);
      let newOwner: string | null | undefined;
      if (patch.ownerHandle !== undefined) {
        newOwner = await this.members.resolveHandle(trx, patch.ownerHandle);
        change('owner_user_id', newOwner, { before: (await personOf(trx, row.owner_user_id))?.handle ?? 'none', after: patch.ownerHandle });
      }
      if (patch.dueAt !== undefined) {
        if (kind.table === PREP) {
          const eventDate = (await sql<{ scheduled_at: string }>`select scheduled_at from audit_event where id = ${row.audit_event_id!}`.execute(trx)).rows[0]?.scheduled_at;
          if (eventDate) await this.rules.enforce<Br43Input>(trx, 'BR-43', { due: patch.dueAt, auditDate: eventDate }, { msIds: [record.ms.id], ref: currentRef });
          if (patch.dueAt !== row.due_at) set.violates_br43 = false;
        }
        change('due_at', patch.dueAt);
      }

      let updatedAt: Date;
      try {
        updatedAt = await writeRow(trx, kind.table, id, set, actor);
      } catch (error) {
        if (isBr43TriggerError(error)) throw br43Problem();
        throw error;
      }
      const ref = refOf(kind.table, id, (set.title as string | undefined) ?? code, updatedAt);
      if (Object.keys(after).length > 0) {
        await this.audit.record(trx, { action: kind.action, msId: record.ms.id, entityType: kind.table, entityId: id, entityCode: code, before, after });
      }
      if (kind.table === PREP && newOwner && newOwner !== row.owner_user_id) {
        await this.notifyPrepAssigned(trx, newOwner, record.ms, ref, (set.due_at as string | undefined) ?? row.due_at);
      }
      return commandResult([record.ms.slug], { ref });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** An audit event of the path system (its `management_system_id`, or a link to it); 404 otherwise. */
  private async event(trx: Trx, system: MsRef, id: string): Promise<EventRow> {
    const { rows } = await sql<EventRow>`
      select e.* from audit_event e
       where e.id = ${id} and e.deleted_at is null
         and (e.management_system_id = ${system.id}
              or exists (select 1 from entity_ms_link l where l.entity_type = 'audit_event' and l.entity_id = e.id
                           and l.management_system_id = ${system.id} and l.deleted_at is null))
       for update of e`.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Unknown audit event');
    return row;
  }

  private async userIdOf(trx: Trx, handle: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`select id from platform.app_user where handle = ${handle}`.execute(trx);
    return rows[0]?.id ?? null;
  }

  private async notifyPrepAssigned(trx: Trx, owner: string, system: MsRef, ref: RecordRef, due: string): Promise<void> {
    await this.notifications.create(trx, {
      recipientUserId: owner,
      kind: 'prep_task_assigned',
      title: { en: `Preparation task assigned: ${ref.code}`, id: `Tugas persiapan ditugaskan: ${ref.code}` },
      body: { en: `${ref.code}, due ${due}`, id: `${ref.code}, tenggat ${due}` },
      msId: system.id,
      ref,
      digest: true,
    });
  }
}

/** The message of a command that started the certification cycle (D.4). */
function cycleMessage(started: StartedCycle): [string, string] {
  return started.activated
    ? [`The planned certification cycle is now active, ${started.items.length} cycle items added`, `Siklus sertifikasi yang direncanakan kini aktif, ${started.items.length} butir siklus ditambahkan`]
    : [`Certification cycle started, ${started.items.length} cycle items added`, `Siklus sertifikasi dimulai, ${started.items.length} butir siklus ditambahkan`];
}

/** After audit flags of a system's chain items by key, with the holder (BR-42 compares two of these). */
function afterFlags(snapshot: UiMsSnapshot): Map<string, { after: boolean; holder: string }> {
  return new Map(snapshot.bundle.chain.items.map((i) => [i.key, { after: i.after, holder: i.h }]));
}
