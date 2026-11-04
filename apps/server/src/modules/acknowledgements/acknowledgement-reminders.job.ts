// `acknowledgement.reminders` job handler (Milestone 3 J.3, D.7 "Reminders"): daily per organisation at 08:10 local
// through `scheduler.tick` (`ak:<org>:<local date>`), on the date of its run (`Clock.runDate`). For every open request:
// - people whose membership ended, who no longer hold a role that puts them in the request's audience, or whom the
//   classification rule no longer lets see the document (it became `restricted`, acknowledgement-visibility.ts),
//   become `excused` with the reason, and their tasks are cancelled (the membership and role services stay unchanged);
// - newcomers (M3-14, ISO review M1): the people who fall in the request's audience now (`audienceOf` with its scope
//   and roles) and have no row get a `pending` row, a stored task and `acknowledgement_requested`, and the request's
//   `audience_count` goes up; a row excused because the membership ended or the role was lost becomes `pending` again
//   when the person is back in the audience (its reminders start again). People who confirmed the same version in an
//   earlier request are not added. Audited as `acknowledgement_request.reminded` with `after.added` and
//   `after.reason: "newcomers"` (no new audit action, R-14). A person added this way has their own due date: the day
//   they were added (the row's `created_at`, set again when a row comes back) plus the request's period (`personDueSql`);
// - pending people are reminded 7 days after the day they were added and on their due date, then every 7 days, at most
//   three times in all (`reminder_count`, manual reminders included); a day the job did not run is caught up once, never
//   twice;
// - a request with people pending past their due date reaches the Management System Managers of its system once, in
//   the digest (`acknowledgement_overdue`).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AcknowledgementRole, AcknowledgementScope } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays, localDate } from '../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { TenantJobRunner } from '../jobs/tenant-job';
import { EXCUSED, RETURNING_REASONS, overdueNotice, requestedNotice, taskTitle } from './acknowledgement-text';
import { addedOnSql, audienceOf, documentRef, excusePending, personDueSql, requestRef, type AudienceQuery } from './acknowledgement.service';
import { remindPending } from './acknowledgement-requests.service';

/** Automatic reminders per person at most (D.7). */
export const MAX_REMINDERS = 3;

export interface AcknowledgementRemindersResult {
  requests: number;
  excused: number;
  /** People added to open requests: newcomers and people back in the audience (M3-14). */
  added: number;
  reminded: number;
  overdueNotices: number;
}

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

/**
 * The reminder date in force on `today`: the latest of start + 7 days (when before the due date), the due date and
 * every 7 days after it, that is not after `today`; null before the first one.
 */
export function reminderDateOn(startedOn: string, dueOn: string, today: string): string | null {
  let latest: string | null = null;
  const first = addDays(startedOn, 7);
  if (first < dueOn && first <= today) latest = first;
  for (let date = dueOn; date <= today; date = addDays(date, 7)) latest = date;
  return latest;
}

/** Whether a pending person is reminded on `today` (D.7): a reminder date is in force and they were not reminded since. */
export function reminderDue(input: { startedOn: string; dueOn: string; today: string; lastRemindedOn: string | null; count: number }): boolean {
  if (input.count >= MAX_REMINDERS) return false;
  const date = reminderDateOn(input.startedOn, input.dueOn, input.today);
  if (!date) return false;
  return input.lastRemindedOn === null || input.lastRemindedOn < date;
}

interface OpenRequestRow {
  id: string;
  management_system_id: string;
  document_id: string;
  document_version_id: string;
  doc_code: string;
  title: string;
  is_org_wide: boolean;
  version_label: string;
  audience_scope: AcknowledgementScope;
  audience_roles: AcknowledgementRole[] | null;
  due_on: string;
  created_at: Date;
}

@Injectable()
@JobHandler('acknowledgement.reminders', { concurrency: 1, scope: 'tenant' })
export class AcknowledgementRemindersJob implements JobHandlerInstance<'acknowledgement.reminders'> {
  private readonly logger = new Logger('acknowledgement.reminders');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  async handle(job: JobRun<'acknowledgement.reminders'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId, job.env.payload.localDate);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...(result ?? {}) }, 'acknowledgement.reminders done');
  }

  /** One run for an organisation on its local date; null when the organisation is gone or not active. */
  async run(orgId: string | null, requestId?: string, runLocalDate?: string): Promise<AcknowledgementRemindersResult | null> {
    const org = await this.runner.organisation(orgId, 'acknowledgement.reminders');
    if (!org) return null;
    const today = await this.clock.runDate(org.id, runLocalDate);
    return this.runner.run(org, (trx) => this.runIn(trx, today, org.timeZone), requestId);
  }

  private async runIn(trx: Trx, today: string, timeZone: string): Promise<AcknowledgementRemindersResult> {
    const result: AcknowledgementRemindersResult = { requests: 0, excused: 0, added: 0, reminded: 0, overdueNotices: 0 };
    const { rows: requests } = await sql<OpenRequestRow>`
      select r.id, r.management_system_id, r.document_id, r.document_version_id, d.doc_code, d.title, d.is_org_wide, v.version_label,
             r.audience_scope, r.audience_roles, r.due_on, r.created_at
        from acknowledgement_request r
        join document d on d.id = r.document_id
        join document_version v on v.id = r.document_version_id
       where r.status = 'open' and r.deleted_at is null
       order by r.created_at, r.id
       for update of r`.execute(trx);
    for (const request of requests) {
      result.requests += 1;
      result.excused += await this.excuse(trx, request);
      result.added += await this.addNewcomers(trx, request, today, timeZone);
      const reminded = await this.remind(trx, request, today, timeZone);
      result.reminded += reminded;
      // Every person's due date is the request's or later, so nobody is overdue before the request's due date.
      if (request.due_on < today) result.overdueNotices += await this.overdue(trx, request, today, timeZone);
    }
    return result;
  }

  /** Excuses pending people who left the organisation or the audience (D.7). */
  private async excuse(trx: Trx, request: OpenRequestRow): Promise<number> {
    const pending = await trx
      .selectFrom('acknowledgement')
      .select(['user_id'])
      .where('acknowledgement_request_id', '=', request.id)
      .where('status', '=', 'pending')
      .where('deleted_at', 'is', null)
      .execute();
    if (pending.length === 0) return 0;
    const query = {
      documentId: request.document_id,
      isOrgWide: request.is_org_wide,
      scope: request.audience_scope,
      roles: request.audience_roles,
      primaryMsId: request.management_system_id,
    };
    const audience = new Set((await audienceOf(trx, query)).map((m) => m.userId));
    const gone = pending.map((p) => p.user_id).filter((id) => !audience.has(id));
    if (gone.length === 0) return 0;
    const members = new Set(
      (await sql<{ user_id: string }>`
        select om.user_id from platform.org_membership om join platform.app_user u on u.id = om.user_id
         where om.organization_id = nullif(current_setting('app.org_id', true), '')::uuid and om.status = 'active' and om.deleted_at is null
           and u.status = 'active' and u.deleted_at is null and om.user_id = any(${gone}::uuid[])`.execute(trx)).rows.map((r) => r.user_id),
    );
    const left = gone.filter((id) => !members.has(id));
    const stayed = gone.filter((id) => members.has(id));
    // Still asked by their role and out only by the classification rule: the document became restricted or changed owner.
    const byRole = stayed.length > 0 ? new Set((await audienceOf(trx, { ...query, ignoreClassification: true })).map((m) => m.userId)) : new Set<string>();
    const hidden = stayed.filter((id) => byRole.has(id));
    const roleless = stayed.filter((id) => !byRole.has(id));
    return (await excusePending(trx, request.id, left, EXCUSED.membershipEnded, SYSTEM_USER_ID))
      + (await excusePending(trx, request.id, roleless, EXCUSED.roleEnded, SYSTEM_USER_ID))
      + (await excusePending(trx, request.id, hidden, EXCUSED.restricted, SYSTEM_USER_ID));
  }

  /**
   * Adds the newcomers of an open request and asks again the people who are back in its audience (M3-14): a `pending`
   * row (or the excused row set back to `pending` with its reminders cleared and its `created_at`, the day it was added,
   * set to now), a stored task due on the person's own due date and `acknowledgement_requested`; the request's
   * `audience_count` grows by the new rows. Returns how many people were added.
   */
  private async addNewcomers(trx: Trx, request: OpenRequestRow, today: string, timeZone: string): Promise<number> {
    const query: AudienceQuery = {
      documentId: request.document_id,
      isOrgWide: request.is_org_wide,
      scope: request.audience_scope,
      roles: request.audience_roles,
      primaryMsId: request.management_system_id,
      skipConfirmedOf: request.document_version_id,
    };
    const audience = await audienceOf(trx, query);
    if (audience.length === 0) return 0;
    const rows = await trx
      .selectFrom('acknowledgement')
      .select(['id', 'user_id', 'status', 'excused_reason'])
      .where('acknowledgement_request_id', '=', request.id)
      .where('deleted_at', 'is', null)
      .execute();
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const newcomers = audience.filter((m) => !byUser.has(m.userId));
    const returning = audience.filter((m) => {
      const row = byUser.get(m.userId);
      return row?.status === 'excused' && row.excused_reason !== null && RETURNING_REASONS.includes(row.excused_reason);
    });
    if (newcomers.length === 0 && returning.length === 0) return 0;

    const inserted = newcomers.length === 0 ? [] : await trx
      .insertInto('acknowledgement')
      .values(newcomers.map((m) => ({ acknowledgement_request_id: request.id, user_id: m.userId, status: 'pending' as const, created_by: SYSTEM_USER_ID, updated_by: SYSTEM_USER_ID })))
      .returning(['id', 'user_id'])
      .execute();
    const back = returning.length === 0 ? [] : await trx
      .updateTable('acknowledgement')
      .set({
        status: 'pending', excused_reason: null, reminded_at: null, reminder_count: 0, created_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID,
      })
      .where('acknowledgement_request_id', '=', request.id)
      .where('status', '=', 'excused')
      .where('user_id', 'in', returning.map((m) => m.userId))
      .returning(['id', 'user_id'])
      .execute();
    const added = [...inserted, ...back];
    const { rows: dues } = await sql<{ id: string; added_on: string; due_on: string }>`
      select a.id, ${addedOnSql(timeZone)}::text as added_on, ${personDueSql(timeZone)}::text as due_on
        from acknowledgement a join acknowledgement_request r on r.id = a.acknowledgement_request_id
       where a.id = any(${added.map((a) => a.id)}::uuid[])`.execute(trx);
    const dueOf = new Map(dues.map((d) => [d.id, d.due_on]));
    const systemOf = new Map(audience.map((m) => [m.userId, m.msId]));
    const facts = { code: request.doc_code, title: request.title, version: request.version_label };
    const title = taskTitle(facts);
    await trx
      .insertInto('task')
      .values(added.map((row) => ({
        management_system_id: systemOf.get(row.user_id) ?? request.management_system_id,
        source_rule: 'acknowledgement' as const,
        entity_type: 'acknowledgement',
        entity_id: row.id,
        entity_code: request.doc_code.slice(0, 80),
        title_en: title.en,
        title_id: title.id,
        owner_user_id: row.user_id,
        due_at: dueOf.get(row.id) ?? request.due_on,
        status: 'open' as const,
        created_by: SYSTEM_USER_ID,
        updated_by: SYSTEM_USER_ID,
      })))
      .execute();
    const ref = documentRef(request.document_id, request.doc_code);
    for (const row of added) {
      const notice = requestedNotice(facts, dueOf.get(row.id) ?? request.due_on, false);
      await this.notifications.create(trx, {
        recipientUserId: row.user_id,
        kind: 'acknowledgement_requested',
        title: notice.title,
        body: notice.body,
        msId: systemOf.get(row.user_id) ?? request.management_system_id,
        ref,
        createdBy: SYSTEM_USER_ID,
      });
    }
    if (inserted.length > 0) {
      await sql`update acknowledgement_request set audience_count = audience_count + ${inserted.length}, updated_by = ${SYSTEM_USER_ID}
                 where id = ${request.id}::uuid`.execute(trx);
    }
    await this.audit.record(trx, {
      action: 'acknowledgement_request.reminded',
      actor: SYSTEM_ACTOR,
      msId: request.management_system_id,
      entityType: 'acknowledgement_request',
      entityId: request.id,
      entityCode: request.doc_code,
      after: { added: added.length, reason: 'newcomers', newcomers: inserted.length, returned: back.length, date: today },
    });
    return added.length;
  }

  /** Reminds the pending people whose reminder date is in force (D.7), each by the day they were added and their due date. */
  private async remind(trx: Trx, request: OpenRequestRow, today: string, timeZone: string): Promise<number> {
    const { rows: pending } = await sql<{ user_id: string; reminded_at: Date | null; reminder_count: number; added_on: string; due_on: string }>`
      select a.user_id, a.reminded_at, a.reminder_count, ${addedOnSql(timeZone)}::text as added_on, ${personDueSql(timeZone)}::text as due_on
        from acknowledgement a join acknowledgement_request r on r.id = a.acknowledgement_request_id
       where a.acknowledgement_request_id = ${request.id}::uuid and a.status = 'pending' and a.deleted_at is null`.execute(trx);
    const due = pending
      .filter((p) => reminderDue({
        startedOn: p.added_on,
        dueOn: p.due_on,
        today,
        lastRemindedOn: p.reminded_at ? localDate(new Date(p.reminded_at), timeZone) : null,
        count: Number(p.reminder_count),
      }))
      .map((p) => p.user_id);
    if (due.length === 0) return 0;
    const reminded = await remindPending(trx, this.notifications, request, SYSTEM_USER_ID, timeZone, due);
    if (reminded === 0) return 0;
    await trx.updateTable('acknowledgement_request').set({ last_reminded_at: sql<Date>`now()`, updated_by: SYSTEM_USER_ID }).where('id', '=', request.id).execute();
    await this.audit.record(trx, {
      action: 'acknowledgement_request.reminded',
      actor: SYSTEM_ACTOR,
      msId: request.management_system_id,
      entityType: 'acknowledgement_request',
      entityId: request.id,
      entityCode: request.doc_code,
      after: { reminded, source: 'schedule', date: today },
    });
    return reminded;
  }

  /**
   * `acknowledgement_overdue` in the digest of the system's Management System Managers, once per request, when people
   * are pending past their own due date (M3-14).
   */
  private async overdue(trx: Trx, request: OpenRequestRow, today: string, timeZone: string): Promise<number> {
    const [counts] = (await sql<{ pending: number }>`
      select count(*)::int as pending
        from acknowledgement a join acknowledgement_request r on r.id = a.acknowledgement_request_id
       where a.acknowledgement_request_id = ${request.id}::uuid and a.status = 'pending' and a.deleted_at is null
         and ${personDueSql(timeZone)} < ${today}::date`.execute(trx)).rows;
    const pending = Number(counts?.pending ?? 0);
    if (pending === 0) return 0;
    const managers = (await sql<{ user_id: string }>`
      select distinct r.user_id from user_ms_role r
       where r.management_system_id = ${request.management_system_id}::uuid and r.role = 'ms_manager' and r.approval_status = 'active'
         and r.deleted_at is null and (r.valid_until is null or r.valid_until > now())
       order by r.user_id`.execute(trx)).rows.map((r) => r.user_id);
    const notice = overdueNotice({ code: request.doc_code, title: request.title, version: request.version_label }, request.due_on, pending);
    let sent = 0;
    for (const manager of managers) {
      const already = await trx
        .selectFrom('notification')
        .select('id')
        .where('kind', '=', 'acknowledgement_overdue')
        .where('recipient_user_id', '=', manager)
        .where(sql<string>`entity_ref->>'id'`, '=', request.id)
        .limit(1)
        .executeTakeFirst();
      if (already) continue;
      const id = await this.notifications.create(trx, {
        recipientUserId: manager,
        kind: 'acknowledgement_overdue',
        title: notice.title,
        body: notice.body,
        msId: request.management_system_id,
        ref: requestRef(request.id, request.doc_code),
        digest: true,
        createdBy: SYSTEM_USER_ID,
      });
      if (id) sent += 1;
    }
    return sent;
  }
}

