// Read confirmation requests (Milestone 3 D.7): the step that opens a request for one approved document version and
// the queries the routes and the daily job share. `DocumentCommandsService.transition` calls `openForApprovedVersion`
// in the approval's transaction when the document asks for read confirmation; `acknowledgement-requests.create` calls
// `openRequest` for the current approved version of a document approved before Milestone 3 (D3-08).
//
// Opening a request:
// - closes the open request of an earlier version of the document: its pending people become `excused` ("Replaced by
//   version X") and their tasks are cancelled (audited `acknowledgement_request.closed`);
// - fixes the audience when the request opens (D.7 "Setting"): `system_roles` is every active member with a business
//   role in a system the document is linked to (every system for an organisation-wide document), `roles` only the
//   holders of the chosen roles there, `organisation` every active member with a business role in any system. Guests,
//   external auditors and members without a business role are never in it;
// - writes one `acknowledgement` row, one stored task (source `acknowledgement`, entity the person's row, C.3) and one
//   `acknowledgement_requested` notification per person, then `acknowledgement_request.created`.
//
// A request belongs to the document's primary system (`management_system_id`) and shows in every system the document
// is linked to (every system for an organisation-wide document) while that system is the document's primary one
// (`requestVisibleIn`). This module imports nothing from
// `registers/`: registers.module.ts imports this one (M3-05 brief).
import { Inject, Injectable } from '@nestjs/common';
import type { AcknowledgementRole, AcknowledgementScope, RecordRef } from '@mscd/shared';
import { sql, type RawBuilder } from 'kysely';
import { addDays } from '../../common/dates';
import { ConflictError, NotFoundError, ProblemError } from '../../common/problems';
import { AUDIT_WRITER, NOTIFICATION_WRITER, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { EXCUSED, REFUSALS, requestedNotice, taskTitle, type DocumentFacts } from './acknowledgement-text';

/** The read confirmation settings of a document (D.7, `DocumentAcknowledgement`). */
export interface AcknowledgementSettings {
  required: boolean;
  scope: AcknowledgementScope;
  roles: AcknowledgementRole[] | null;
  dueDays: number;
}

/** The default settings of a document (H.7: the people with a role in its systems, 14 days). */
export const DEFAULT_SETTINGS: AcknowledgementSettings = { required: false, scope: 'system_roles', roles: null, dueDays: 14 };

/** The business roles that can be asked to confirm (J.7 `acknowledgement_roles`: never the external auditor). */
export const AUDIENCE_ROLES: readonly AcknowledgementRole[] = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator',
];

/** The settings stored on a `document` row. */
export function settingsOfRow(row: {
  acknowledgement_required?: boolean | null;
  acknowledgement_scope?: string | null;
  acknowledgement_roles?: readonly string[] | null;
  acknowledgement_due_days?: number | null;
}): AcknowledgementSettings {
  const scope = (row.acknowledgement_scope ?? 'system_roles') as AcknowledgementScope;
  return {
    required: row.acknowledgement_required === true,
    scope,
    roles: scope === 'roles' && row.acknowledgement_roles ? ([...row.acknowledgement_roles] as AcknowledgementRole[]) : null,
    dueDays: row.acknowledgement_due_days ?? 14,
  };
}

/** Whether two settings are the same (roles compared as sets). */
export function sameSettings(a: AcknowledgementSettings, b: AcknowledgementSettings): boolean {
  const roles = (r: readonly string[] | null) => (r ? [...r].sort().join(',') : '');
  return a.required === b.required && a.scope === b.scope && roles(a.roles) === roles(b.roles) && a.dueDays === b.dueDays;
}

/** One person of an audience and the system their task is listed in (a system where they hold a role). */
export interface AudienceMember {
  userId: string;
  msId: string;
}

export interface AudienceQuery {
  documentId: string;
  isOrgWide: boolean;
  scope: AcknowledgementScope;
  roles: readonly AcknowledgementRole[] | null;
  /** The request's system: the task of a person who holds a role there is listed there. */
  primaryMsId: string;
}

export interface OpenRequestInput {
  actorId: string;
  /** Today in the organisation (the request's start; the due date counts from it). */
  today: string;
  document: { id: string; code: string; title: string; isOrgWide: boolean };
  version: { id: string; label: string };
  scope: AcknowledgementScope;
  roles: readonly AcknowledgementRole[] | null;
  dueDays: number;
}

export interface OpenedRequest {
  id: string;
  msId: string;
  audience: number;
  dueOn: string;
  /** Requests of earlier versions closed by this one. */
  replaced: number;
}

/** 422 `business-rule` with a message key and both texts (refusals of D.7 that carry no rule id). */
export function refusal(entry: { key: string; en: string; id: string }): ProblemError {
  return new ProblemError('business-rule', { messageKey: entry.key, messages: { en: entry.en, id: entry.id }, detail: entry.en });
}

/** 409 with a message key and both texts. */
export function conflict(entry: { key: string; en: string; id: string }): ConflictError {
  return new ConflictError(entry.en, { messageKey: entry.key, messages: { en: entry.en, id: entry.id } });
}

/** The record ref of a document (notifications and command results). */
export function documentRef(id: string, code: string): RecordRef {
  return { module: 'implementation', entityType: 'document', id, code };
}

/** The record ref of a confirmation request. */
export function requestRef(id: string, code: string): RecordRef {
  return { module: 'implementation', entityType: 'acknowledgement_request', id, code };
}

/**
 * SQL condition: the request `r` shows in the system `msId` (D.7): it belongs to that system, or its document counts
 * in that system (linked to it, or organisation-wide, which counts in every system as the snapshot lists it) and the
 * request's own system is still the document's primary one.
 */
export function requestVisibleIn(msId: string): RawBuilder<boolean> {
  return sql<boolean>`(r.management_system_id = ${msId}::uuid
    or ((exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = r.document_id
                   and l.management_system_id = ${msId}::uuid and l.deleted_at is null)
         or exists (select 1 from document w where w.id = r.document_id and w.is_org_wide and w.deleted_at is null))
        and exists (select 1 from entity_ms_link p where p.entity_type = 'document' and p.entity_id = r.document_id
                      and p.management_system_id = r.management_system_id and p.is_primary and p.deleted_at is null)))`;
}

@Injectable()
export class AcknowledgementService {
  constructor(
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /**
   * Approval of a new version of a document that asks for read confirmation (`documents.transition` to `approved`,
   * D.2): opens the request of that version in the approval's transaction and closes the request of the earlier
   * version. A document whose audience is empty gets no request (nobody to ask); the earlier request still closes.
   */
  async openForApprovedVersion(trx: Trx, input: OpenRequestInput): Promise<OpenedRequest | null> {
    return this.openRequest(trx, input, { emptyAudience: 'skip' });
  }

  /**
   * Opens the request of `input.version` (D.7 "Request"). 409 when the version has an open request; with
   * `emptyAudience: 'refuse'` 422 when nobody is in the audience, with `skip` null (after closing earlier requests).
   */
  async openRequest(trx: Trx, input: OpenRequestInput, options: { emptyAudience: 'refuse' | 'skip' }): Promise<OpenedRequest | null> {
    const msId = await primarySystemOf(trx, input.document.id);
    const open = await trx
      .selectFrom('acknowledgement_request')
      .select('id')
      .where('document_version_id', '=', input.version.id)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (open) throw conflict(REFUSALS.openRequest);
    const people = await audienceOf(trx, { documentId: input.document.id, isOrgWide: input.document.isOrgWide, scope: input.scope, roles: input.roles, primaryMsId: msId });
    if (people.length === 0 && options.emptyAudience === 'refuse') throw refusal(REFUSALS.noAudience);
    const replaced = await this.closeEarlierRequests(trx, input.document, input.version, input.actorId);
    if (people.length === 0) return null;

    const dueOn = addDays(input.today, input.dueDays);
    const roles = input.scope === 'roles' && input.roles ? [...input.roles] : null;
    const request = await trx
      .insertInto('acknowledgement_request')
      .values({
        management_system_id: msId,
        document_id: input.document.id,
        document_version_id: input.version.id,
        status: 'open',
        audience_scope: input.scope,
        audience_roles: roles,
        audience_count: people.length,
        due_on: dueOn,
        created_by: input.actorId,
        updated_by: input.actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const facts: DocumentFacts = { code: input.document.code, title: input.document.title, version: input.version.label };
    const rows = await trx
      .insertInto('acknowledgement')
      .values(people.map((p) => ({ acknowledgement_request_id: request.id, user_id: p.userId, status: 'pending' as const, created_by: input.actorId, updated_by: input.actorId })))
      .returning(['id', 'user_id'])
      .execute();
    const systemOf = new Map(people.map((p) => [p.userId, p.msId]));
    const title = taskTitle(facts);
    await trx
      .insertInto('task')
      .values(rows.map((row) => ({
        management_system_id: systemOf.get(row.user_id) ?? msId,
        source_rule: 'acknowledgement' as const,
        entity_type: 'acknowledgement',
        entity_id: row.id,
        entity_code: input.document.code.slice(0, 80),
        title_en: title.en,
        title_id: title.id,
        owner_user_id: row.user_id,
        due_at: dueOn,
        status: 'open' as const,
        created_by: input.actorId,
        updated_by: input.actorId,
      })))
      .execute();
    const notice = requestedNotice(facts, dueOn, false);
    const ref = documentRef(input.document.id, input.document.code);
    for (const row of rows) {
      await this.notifications.create(trx, {
        recipientUserId: row.user_id,
        kind: 'acknowledgement_requested',
        title: notice.title,
        body: notice.body,
        msId: systemOf.get(row.user_id) ?? msId,
        ref,
        createdBy: input.actorId,
      });
    }
    await this.audit.record(trx, {
      action: 'acknowledgement_request.created',
      msId,
      entityType: 'acknowledgement_request',
      entityId: request.id,
      entityCode: input.document.code,
      after: {
        document: input.document.code,
        version: input.version.label,
        audience_scope: input.scope,
        ...(roles ? { audience_roles: roles } : {}),
        audience: people.length,
        due_on: dueOn,
      },
    });
    return { id: request.id, msId, audience: people.length, dueOn, replaced };
  }

  /**
   * Closes the open requests of the document's other versions: pending people become `excused` ("Replaced by version
   * X"), their tasks are cancelled. Returns how many requests closed.
   */
  private async closeEarlierRequests(trx: Trx, document: { id: string; code: string }, version: { id: string; label: string }, actorId: string): Promise<number> {
    const earlier = await trx
      .selectFrom('acknowledgement_request as r')
      .innerJoin('document_version as v', 'v.id', 'r.document_version_id')
      .select(['r.id', 'r.management_system_id', 'v.version_label'])
      .where('r.document_id', '=', document.id)
      .where('r.document_version_id', '<>', version.id)
      .where('r.status', '=', 'open')
      .where('r.deleted_at', 'is', null)
      .forUpdate('r')
      .execute();
    for (const request of earlier) {
      const reason = EXCUSED.replaced(version.label);
      const excused = await excusePending(trx, request.id, null, reason, actorId);
      await trx
        .updateTable('acknowledgement_request')
        .set({ status: 'closed', closed_at: sql<Date>`now()`, closed_by: actorId, updated_by: actorId })
        .where('id', '=', request.id)
        .execute();
      await this.audit.record(trx, {
        action: 'acknowledgement_request.closed',
        msId: request.management_system_id,
        entityType: 'acknowledgement_request',
        entityId: request.id,
        entityCode: document.code,
        before: { status: 'open' },
        after: { status: 'closed', version: request.version_label, replaced_by: version.label, excused },
      });
    }
    return earlier.length;
  }
}

/** The document's primary system (`entity_ms_link.is_primary`, else its first link); 404 when it has none. */
export async function primarySystemOf(trx: Trx, documentId: string): Promise<string> {
  const row = await trx
    .selectFrom('entity_ms_link as l')
    .innerJoin('management_system as m', 'm.id', 'l.management_system_id')
    .select('l.management_system_id')
    .where('l.entity_type', '=', 'document')
    .where('l.entity_id', '=', documentId)
    .where('l.deleted_at', 'is', null)
    .where('m.deleted_at', 'is', null)
    .orderBy('l.is_primary', 'desc')
    .orderBy('l.created_at')
    .limit(1)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('The document is linked to no management system');
  return row.management_system_id;
}

/**
 * The people of an audience (D.7 "Setting"), each with the system their task is listed in: the request's system when
 * they hold a role there, else the first such system by slug. Active members with an active business role (approved,
 * not expired) other than the external auditor; accounts of kind `person` only (no guests, no system user).
 */
export async function audienceOf(trx: Trx, query: AudienceQuery): Promise<AudienceMember[]> {
  const everySystem = query.scope === 'organisation' || query.isOrgWide;
  const roles = query.scope === 'roles' && query.roles && query.roles.length > 0 ? [...query.roles] : null;
  const { rows } = await sql<{ user_id: string; ms_id: string }>`
    with target as (
      select m.id, m.slug from management_system m
       where m.deleted_at is null and m.status <> 'archived'
         and (${everySystem}::boolean
              or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = ${query.documentId}::uuid
                           and l.management_system_id = m.id and l.deleted_at is null))
    )
    select r.user_id, (array_agg(t.id order by (t.id = ${query.primaryMsId}::uuid) desc, t.slug))[1] as ms_id
      from user_ms_role r
      join target t on t.id = r.management_system_id
      join platform.app_user u on u.id = r.user_id and u.status = 'active' and u.deleted_at is null and u.kind = 'person'
      join platform.org_membership om on om.user_id = r.user_id and om.status = 'active' and om.deleted_at is null
       and om.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
     where r.deleted_at is null and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > now())
       and r.role = any(${[...AUDIENCE_ROLES]}::text[])
       and (${roles}::text[] is null or r.role = any(${roles}::text[]))
     group by r.user_id
     order by r.user_id`.execute(trx);
  return rows.map((r) => ({ userId: r.user_id, msId: r.ms_id }));
}

/**
 * Marks pending people of a request `excused` with a reason and cancels their open tasks; `userIds` limits it to those
 * people (null: every pending person). Returns how many became excused.
 */
export async function excusePending(trx: Trx, requestId: string, userIds: readonly string[] | null, reason: string, actorId: string): Promise<number> {
  if (userIds && userIds.length === 0) return 0;
  let update = trx
    .updateTable('acknowledgement')
    .set({ status: 'excused', excused_reason: reason.slice(0, 200), updated_by: actorId })
    .where('acknowledgement_request_id', '=', requestId)
    .where('status', '=', 'pending')
    .where('deleted_at', 'is', null);
  if (userIds) update = update.where('user_id', 'in', [...userIds]);
  const excused = await update.returning('id').execute();
  await closeTasks(trx, excused.map((e) => e.id), 'cancelled', actorId);
  return excused.length;
}

/** Closes the open stored tasks of acknowledgement rows (`done` when confirmed, `cancelled` otherwise). */
export async function closeTasks(trx: Trx, acknowledgementIds: readonly string[], status: 'done' | 'cancelled', actorId: string): Promise<number> {
  if (acknowledgementIds.length === 0) return 0;
  const closed = await trx
    .updateTable('task')
    .set({ status, closed_by: actorId, closed_at: sql<Date>`now()`, updated_by: actorId })
    .where('source_rule', '=', 'acknowledgement')
    .where('entity_type', '=', 'acknowledgement')
    .where('entity_id', 'in', [...acknowledgementIds])
    .where('status', '=', 'open')
    .where('deleted_at', 'is', null)
    .returning('id')
    .execute();
  return closed.length;
}
