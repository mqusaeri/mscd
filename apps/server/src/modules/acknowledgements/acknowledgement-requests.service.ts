// The confirmation requests of a system (Milestone 3 D.1, D.7): the list with totals, a request by hand for the
// current approved version of a document, one request with the person list where the permission allows, a reminder
// by the manager (at most once a day), closing a request with the register filed as a new file of an evidence item
// (`FileCommandsService.fileGeneratedEvidence`, M3-01), and the register as CSV.
//
// Who sees what (D.7 "Register", product decisions 2 and 3): the list needs `acknowledgement.manage` or
// `audit.pending.aggregate`; the totals of one request `audit.pending.all` or `audit.pending.aggregate`; the person list
// and the CSV only `audit.pending.all` (Management System Manager, Programme Owner). Top Management sees totals only;
// Internal Auditors see neither and read the filed register as evidence. Restricted documents stay hidden from callers
// who may not see them in the system (scope policy, F.7).
import { Inject, Injectable } from '@nestjs/common';
import type {
  AcknowledgementPerson, AcknowledgementRequestClose, AcknowledgementRequestCreate, AcknowledgementRequestDetail, AcknowledgementRequestItem,
  AcknowledgementRole, AcknowledgementScope, CommandResult,
} from '@mscd/shared';
import { sql } from 'kysely';
import { erasedJoin, shownHandle, shownName } from '../privacy/pseudonym';
import { Clock } from '../../common/clock';
import { localDate } from '../../common/dates';
import { NotFoundError } from '../../common/problems';
import { toSafeCsv } from '../../common/spreadsheet-safe';
import {
  AUDIT_WRITER, NOTIFICATION_WRITER, PERMISSION_EVALUATOR, RECORD_RESOLVER, type AuditWriter, type NotificationWriter, type PermissionEvaluator,
  type Principal, type RecordResolver, type TenantInfo, type Trx,
} from '../../common/tokens';
import { ScopePolicyService, type ScopeContext } from '../authz/scope-policy';
import { FileCommandsService } from '../files/file-commands.service';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { REFUSALS, REGISTER_COLUMNS, requestedNotice } from './acknowledgement-text';
import {
  AcknowledgementService, closeTasks, conflict, documentRef, refusal, requestRef, requestVisibleIn, settingsOfRow,
} from './acknowledgement.service';

/** A request row with its document, version and totals. */
interface RequestRow {
  id: string;
  ms: string;
  management_system_id: string;
  document_id: string;
  doc_code: string;
  title: string;
  classification: string;
  version_id: string;
  version_label: string;
  status: 'open' | 'closed';
  audience_scope: AcknowledgementScope;
  audience_roles: AcknowledgementRole[] | null;
  due_on: string;
  created_at: Date;
  last_reminded_at: Date | null;
  closed_at: Date | null;
  evidence_id: string | null;
  audience: number;
  confirmed: number;
  pending: number;
  overdue: number;
  excused: number;
}

/** One person of a request as the register lists them. */
interface PersonRow {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  status: 'pending' | 'confirmed' | 'excused';
  opened_at: Date | null;
  confirmed_at: Date | null;
  reminder_count: number;
  excused_reason: string | null;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The API item of a request row. */
export function requestItem(row: RequestRow): AcknowledgementRequestItem {
  return {
    id: row.id,
    ms: row.ms,
    document: { id: row.document_id, code: row.doc_code, title: row.title },
    version: { id: row.version_id, label: row.version_label },
    status: row.status,
    audienceScope: row.audience_scope,
    audienceRoles: row.audience_scope === 'roles' && row.audience_roles ? [...row.audience_roles] : null,
    dueOn: row.due_on,
    createdAt: new Date(row.created_at).toISOString(),
    lastRemindedAt: iso(row.last_reminded_at),
    closedAt: iso(row.closed_at),
    evidenceId: row.evidence_id,
    totals: {
      audience: Number(row.audience),
      confirmed: Number(row.confirmed),
      pending: Number(row.pending),
      overdue: Number(row.overdue),
      excused: Number(row.excused),
    },
  };
}

@Injectable()
export class AcknowledgementRequestsService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly policy: ScopePolicyService,
    private readonly acknowledgements: AcknowledgementService,
    private readonly files: FileCommandsService,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/acknowledgement-requests
  // -------------------------------------------------------------------------------------------------------------

  async list(principal: Principal, ms: string): Promise<AcknowledgementRequestItem[]> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const scope = await this.policy.scopeContext(trx, principal, ms);
      const rows = await this.requestRows(trx, system.id, this.clock.todayIn(org.timeZone), null);
      return rows.filter((r) => this.policy.documentVisible(scope, r.doc_code)).map(requestItem);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/acknowledgement-requests
  // -------------------------------------------------------------------------------------------------------------

  async create(principal: Principal, ms: string, body: AcknowledgementRequestCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const record = await this.documentIn(trx, ms, body.documentId);
      const doc = record.row as unknown as {
        id: string; doc_code: string; title: string; status: string; current_version_id: string | null; is_org_wide: boolean;
        acknowledgement_required: boolean; acknowledgement_scope: string; acknowledgement_roles: string[] | null; acknowledgement_due_days: number;
      };
      if (doc.status !== 'approved' || !doc.current_version_id) throw refusal(REFUSALS.notApproved);
      const version = await trx
        .selectFrom('document_version')
        .select(['id', 'version_label', 'status'])
        .where('id', '=', doc.current_version_id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!version || version.status !== 'approved') throw refusal(REFUSALS.notApproved);
      const settings = settingsOfRow(doc);
      const scope = body.audience?.scope ?? settings.scope;
      const roles = scope === 'roles' ? (body.audience?.roles ?? settings.roles) : null;
      if (scope === 'roles' && (!roles || roles.length === 0)) throw refusal(REFUSALS.noAudience);
      const opened = await this.acknowledgements.openRequest(
        trx,
        {
          actorId: actor,
          today: this.clock.todayIn(org.timeZone),
          document: { id: doc.id, code: doc.doc_code, title: doc.title, isOrgWide: doc.is_org_wide },
          version: { id: version.id, label: version.version_label },
          scope,
          roles,
          dueDays: body.dueDays ?? settings.dueDays,
        },
        { emptyAudience: 'refuse' },
      );
      const result = opened!;
      return {
        ok: true,
        changed: [record.ms.slug],
        ref: requestRef(result.id, doc.doc_code),
        data: { id: result.id, audience: result.audience, dueOn: result.dueOn, replaced: result.replaced },
        message: [
          `Asked ${result.audience === 1 ? '1 person' : `${result.audience} people`} to confirm ${doc.doc_code} version ${version.version_label}`,
          `${result.audience} orang diminta mengonfirmasi ${doc.doc_code} versi ${version.version_label}`,
        ],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/acknowledgement-requests/{id}
  // -------------------------------------------------------------------------------------------------------------

  async get(principal: Principal, ms: string, id: string): Promise<AcknowledgementRequestDetail> {
    const org = orgOf(principal);
    const withPeople = (await this.evaluator.evaluate(principal, 'audit.pending.all', { scope: 'ms', ms })) === 'full';
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      const row = await this.visibleRequest(trx, principal, ms, id, today);
      const item = requestItem(row);
      if (!withPeople) return item;
      const people = await peopleOf(trx, id);
      return { ...item, people: people.map((p) => personItem(p, row, today)) };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/acknowledgement-requests/{id}/remind
  // -------------------------------------------------------------------------------------------------------------

  async remind(principal: Principal, ms: string, id: string): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      const row = await this.visibleRequest(trx, principal, ms, id, today, { forUpdate: true });
      if (row.status !== 'open') throw conflict(REFUSALS.requestClosed);
      if (row.last_reminded_at && localDate(new Date(row.last_reminded_at), org.timeZone) === localDate(this.clock.now(), org.timeZone)) {
        throw conflict(REFUSALS.remindedToday);
      }
      const reminded = await remindPending(trx, this.notifications, row, actor);
      if (reminded === 0) throw conflict(REFUSALS.nothingPending);
      await trx.updateTable('acknowledgement_request').set({ last_reminded_at: sql<Date>`now()`, updated_by: actor }).where('id', '=', id).execute();
      await this.audit.record(trx, {
        action: 'acknowledgement_request.reminded',
        msId: row.management_system_id,
        entityType: 'acknowledgement_request',
        entityId: id,
        entityCode: row.doc_code,
        after: { reminded, source: 'manager' },
      });
      return {
        ok: true,
        changed: [ms],
        count: reminded,
        ref: requestRef(id, row.doc_code),
        message: [
          `Reminded ${reminded === 1 ? '1 person' : `${reminded} people`} to confirm ${row.doc_code}`,
          `${reminded} orang diingatkan untuk mengonfirmasi ${row.doc_code}`,
        ],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/acknowledgement-requests/{id}/close
  // -------------------------------------------------------------------------------------------------------------

  async close(principal: Principal, ms: string, id: string, body: AcknowledgementRequestClose): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      const row = await this.visibleRequest(trx, principal, ms, id, today, { forUpdate: true });
      if (row.status !== 'open') throw conflict(REFUSALS.requestClosed);
      const system = await this.records.resolveMs(trx, ms);
      const changed = new Set<string>([ms]);
      let filed: { evidenceCode: string; storageObjectId: string; versionLabel: string | null; warnings: CommandResult['warnings'] } | null = null;
      if (body.evidenceId) {
        const people = await peopleOf(trx, id);
        const csv = registerCsv(row, people, today);
        const fileName = registerFileName(row, today);
        const result = await this.files.fileGeneratedEvidence(trx, { userId: actor, kind: 'user' }, {
          msId: system.id,
          evidenceId: body.evidenceId,
          fileName,
          mimeType: 'text/csv',
          bytes: Buffer.from(csv, 'utf8'),
        });
        const evidence = await trx.selectFrom('evidence').select('evidence_code').where('id', '=', body.evidenceId).executeTakeFirstOrThrow();
        for (const slug of await evidenceSystemSlugs(trx, body.evidenceId)) changed.add(slug);
        filed = { evidenceCode: evidence.evidence_code, storageObjectId: result.storageObjectId, versionLabel: result.versionLabel, warnings: result.warnings };
      }
      const pending = await trx
        .selectFrom('acknowledgement')
        .select('id')
        .where('acknowledgement_request_id', '=', id)
        .where('status', '=', 'pending')
        .where('deleted_at', 'is', null)
        .execute();
      await closeTasks(trx, pending.map((p) => p.id), 'cancelled', actor);
      await trx
        .updateTable('acknowledgement_request')
        .set({ status: 'closed', closed_at: sql<Date>`now()`, closed_by: actor, evidence_id: body.evidenceId ?? null, updated_by: actor })
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, {
        action: 'acknowledgement_request.closed',
        msId: row.management_system_id,
        entityType: 'acknowledgement_request',
        entityId: id,
        entityCode: row.doc_code,
        before: { status: 'open' },
        after: {
          status: 'closed',
          version: row.version_label,
          confirmed: Number(row.confirmed),
          pending: Number(row.pending),
          excused: Number(row.excused),
          ...(filed ? { evidence: filed.evidenceCode, storage_object_id: filed.storageObjectId } : {}),
        },
      });
      return {
        ok: true,
        changed: [...changed],
        ref: requestRef(id, row.doc_code),
        ...(filed?.warnings && filed.warnings.length > 0 ? { warnings: filed.warnings } : {}),
        ...(filed ? { data: { evidenceId: body.evidenceId, evidenceCode: filed.evidenceCode, storageObjectId: filed.storageObjectId } } : {}),
        message: filed
          ? [`Request closed. The register is filed as a new file of ${filed.evidenceCode}.`, `Permintaan ditutup. Register disimpan sebagai berkas baru ${filed.evidenceCode}.`]
          : ['Request closed. Reminders stop.', 'Permintaan ditutup. Pengingat berhenti.'],
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/acknowledgement-requests/{id}/export
  // -------------------------------------------------------------------------------------------------------------

  /** The register CSV of a request with its file name and the system id for the download's audit entry. */
  async exportCsv(principal: Principal, ms: string, id: string): Promise<{ csv: string; fileName: string; msId: string; code: string }> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const today = this.clock.todayIn(org.timeZone);
      const row = await this.visibleRequest(trx, principal, ms, id, today);
      const people = await peopleOf(trx, id);
      const system = await this.records.resolveMs(trx, ms);
      return { csv: registerCsv(row, people, today), fileName: registerFileName(row, today), msId: system.id, code: row.doc_code };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The document a request by hand names, locked: one linked to the path system (the record resolver, F.7), or an
   * organisation-wide document, which counts in every system (D.7 "Setting") and is listed in every system's snapshot.
   */
  private async documentIn(trx: Trx, ms: string, id: string): Promise<{ ms: { id: string; slug: string }; row: Record<string, unknown> }> {
    try {
      return await this.records.resolve(trx, ms, 'document', id, { forUpdate: true });
    } catch (error) {
      if (!(error instanceof NotFoundError) || !/^[0-9a-f-]{36}$/i.test(id)) throw error;
      const system = await this.records.resolveMs(trx, ms);
      const { rows } = await sql<Record<string, unknown>>`
        select d.* from document d where d.id = ${id}::uuid and d.is_org_wide and d.deleted_at is null for update of d`.execute(trx);
      if (!rows[0]) throw error;
      return { ms: system, row: rows[0] };
    }
  }

  /** The request `id` as the system `ms` shows it, with its totals; 404 when it does not show there. */
  private async visibleRequest(trx: Trx, principal: Principal, ms: string, id: string, today: string, options: { forUpdate?: boolean } = {}): Promise<RequestRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
    const system = await this.records.resolveMs(trx, ms);
    if (options.forUpdate) {
      await sql`select id from acknowledgement_request where id = ${id}::uuid and deleted_at is null for update`.execute(trx);
    }
    const [row] = await this.requestRows(trx, system.id, today, id);
    if (!row) throw new NotFoundError();
    const scope: ScopeContext = await this.policy.scopeContext(trx, principal, ms);
    if (!this.policy.documentVisible(scope, row.doc_code)) throw new NotFoundError();
    return row;
  }

  /** The requests that show in a system (or one of them), open first, newest first, with their totals. */
  private async requestRows(trx: Trx, msId: string, today: string, id: string | null): Promise<RequestRow[]> {
    const { rows } = await sql<RequestRow>`
      select r.id, m.slug as ms, r.management_system_id, d.id as document_id, d.doc_code, d.title, d.classification,
             v.id as version_id, v.version_label, r.status, r.audience_scope, r.audience_roles, r.due_on, r.created_at,
             r.last_reminded_at, r.closed_at, r.evidence_id,
             count(a.id)::int as audience,
             count(a.id) filter (where a.status = 'confirmed')::int as confirmed,
             count(a.id) filter (where a.status = 'pending')::int as pending,
             count(a.id) filter (where a.status = 'pending' and r.due_on < ${today}::date)::int as overdue,
             count(a.id) filter (where a.status = 'excused')::int as excused
        from acknowledgement_request r
        join management_system m on m.id = r.management_system_id
        join document d on d.id = r.document_id and d.deleted_at is null
        join document_version v on v.id = r.document_version_id
        left join acknowledgement a on a.acknowledgement_request_id = r.id and a.deleted_at is null
       where r.deleted_at is null and ${requestVisibleIn(msId)}
         and (${id}::uuid is null or r.id = ${id}::uuid)
       group by r.id, m.slug, d.id, v.id
       order by (r.status = 'open') desc, r.created_at desc, r.id
       limit 500`.execute(trx);
    return rows;
  }
}

/** The current organisation of a session (every route of this area runs in one). */
export function orgOf(principal: Principal): TenantInfo {
  if (!principal.org) throw new NotFoundError('No organisation is selected');
  return principal.org;
}

/** The people of a request, by name (a person erased in this organisation by the pseudonym, Milestone 3 D.6.5). */
export async function peopleOf(trx: Trx, requestId: string): Promise<PersonRow[]> {
  const { rows } = await sql<PersonRow>`
    select a.id, a.user_id, ${shownHandle('u', 'e')} as handle, ${shownName('u', 'e')} as display_name, a.status, a.opened_at, a.confirmed_at,
           a.reminder_count, a.excused_reason
      from acknowledgement a join platform.app_user u on u.id = a.user_id
      ${erasedJoin('e', 'a.user_id')}
     where a.acknowledgement_request_id = ${requestId}::uuid and a.deleted_at is null
     order by case a.status when 'pending' then 0 when 'confirmed' then 1 else 2 end, ${shownName('u', 'e')}, ${shownHandle('u', 'e')}`.execute(trx);
  return rows;
}

function personItem(p: PersonRow, request: Pick<RequestRow, 'due_on'>, today: string): AcknowledgementPerson {
  return {
    person: { handle: p.handle, displayName: p.display_name },
    status: p.status,
    openedAt: iso(p.opened_at),
    confirmedAt: iso(p.confirmed_at),
    reminderCount: Number(p.reminder_count),
    excusedReason: p.excused_reason,
    overdue: p.status === 'pending' && request.due_on < today,
  };
}

/** The confirmation register as formula-safe CSV (F.15): one row per person of the request. */
export function registerCsv(request: Pick<RequestRow, 'doc_code' | 'title' | 'version_label' | 'due_on'>, people: readonly PersonRow[], today: string): string {
  const rows = people.map((p) => [
    request.doc_code,
    request.title,
    request.version_label,
    request.due_on,
    p.handle,
    p.display_name,
    p.status,
    iso(p.opened_at),
    iso(p.confirmed_at),
    Number(p.reminder_count),
    p.status === 'pending' && request.due_on < today ? 'yes' : 'no',
    p.excused_reason,
  ]);
  return toSafeCsv(rows, REGISTER_COLUMNS);
}

/** `read-confirmations-<code>-v<version>-<date>.csv`. */
export function registerFileName(request: Pick<RequestRow, 'doc_code' | 'version_label'>, today: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `read-confirmations-${safe(request.doc_code)}-v${safe(request.version_label)}-${today}.csv`;
}

/** Slugs of the systems an evidence item belongs to (its links and targets), whose snapshots change with a new file. */
async function evidenceSystemSlugs(trx: Trx, evidenceId: string): Promise<string[]> {
  const { rows } = await sql<{ slug: string }>`
    select distinct m.slug from management_system m
     where m.deleted_at is null
       and (exists (select 1 from entity_ms_link l where l.entity_type = 'evidence' and l.entity_id = ${evidenceId}::uuid
                      and l.management_system_id = m.id and l.deleted_at is null)
            or exists (select 1 from evidence_target t where t.evidence_id = ${evidenceId}::uuid
                         and t.management_system_id = m.id and t.deleted_at is null))`.execute(trx);
  return rows.map((r) => r.slug);
}

/**
 * Sends `acknowledgement_requested` again to every pending person of an open request and counts the reminder on each
 * row (`reminded_at`, `reminder_count`). Returns how many were reminded.
 */
export async function remindPending(
  trx: Trx,
  notifications: NotificationWriter,
  request: Pick<RequestRow, 'id' | 'document_id' | 'doc_code' | 'title' | 'version_label' | 'due_on' | 'management_system_id'>,
  actorId: string,
  userIds?: readonly string[],
): Promise<number> {
  let query = trx
    .updateTable('acknowledgement')
    .set((eb) => ({ reminded_at: sql<Date>`now()`, reminder_count: eb('reminder_count', '+', 1), updated_by: actorId }))
    .where('acknowledgement_request_id', '=', request.id)
    .where('status', '=', 'pending')
    .where('deleted_at', 'is', null);
  if (userIds) {
    if (userIds.length === 0) return 0;
    query = query.where('user_id', 'in', [...userIds]);
  }
  const reminded = await query.returning(['id', 'user_id']).execute();
  const notice = requestedNotice({ code: request.doc_code, title: request.title, version: request.version_label }, request.due_on, true);
  const ref = documentRef(request.document_id, request.doc_code);
  const systems = await taskSystems(trx, reminded.map((r) => r.id));
  for (const row of reminded) {
    await notifications.create(trx, {
      recipientUserId: row.user_id,
      kind: 'acknowledgement_requested',
      title: notice.title,
      body: notice.body,
      msId: systems.get(row.id) ?? request.management_system_id,
      ref,
      createdBy: actorId,
    });
  }
  return reminded.length;
}

/** The system of each person's task (the system they hold a role in), by acknowledgement id. */
async function taskSystems(trx: Trx, acknowledgementIds: readonly string[]): Promise<Map<string, string>> {
  if (acknowledgementIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('task')
    .select(['entity_id', 'management_system_id'])
    .where('source_rule', '=', 'acknowledgement')
    .where('entity_type', '=', 'acknowledgement')
    .where('entity_id', 'in', [...acknowledgementIds])
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute();
  const out = new Map<string, string>();
  for (const row of rows) if (row.management_system_id) out.set(row.entity_id, row.management_system_id);
  return out;
}
