// `acknowledgement.reminders` job handler (Milestone 3 J.3, D.7 "Reminders"): daily per organisation at 08:10 local
// through `scheduler.tick` (`ak:<org>:<local date>`), on the date of its run (`Clock.runDate`). For every open request:
// - people whose membership ended, who no longer hold a role that puts them in the request's audience, or whom the
//   classification rule no longer lets see the document (it became `restricted`, acknowledgement-visibility.ts),
//   become `excused` with the reason, and their tasks are cancelled (the membership and role services stay unchanged);
// - pending people are reminded 7 days after the start and on the due date, then every 7 days, at most three times in
//   all (`reminder_count`, manual reminders included); a day the job did not run is caught up once, never twice;
// - a request past its due date with people still pending reaches the Management System Managers of its system once,
//   in the digest (`acknowledgement_overdue`).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AcknowledgementRole, AcknowledgementScope } from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { addDays, localDate } from '../../common/dates';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { TenantJobRunner } from '../jobs/tenant-job';
import { EXCUSED, overdueNotice } from './acknowledgement-text';
import { audienceOf, excusePending, requestRef } from './acknowledgement.service';
import { remindPending } from './acknowledgement-requests.service';

/** Automatic reminders per person at most (D.7). */
export const MAX_REMINDERS = 3;

export interface AcknowledgementRemindersResult {
  requests: number;
  excused: number;
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
    const result: AcknowledgementRemindersResult = { requests: 0, excused: 0, reminded: 0, overdueNotices: 0 };
    const { rows: requests } = await sql<OpenRequestRow>`
      select r.id, r.management_system_id, r.document_id, d.doc_code, d.title, d.is_org_wide, v.version_label, r.audience_scope,
             r.audience_roles, r.due_on, r.created_at
        from acknowledgement_request r
        join document d on d.id = r.document_id
        join document_version v on v.id = r.document_version_id
       where r.status = 'open' and r.deleted_at is null
       order by r.created_at, r.id
       for update of r`.execute(trx);
    for (const request of requests) {
      result.requests += 1;
      result.excused += await this.excuse(trx, request);
      const reminded = await this.remind(trx, request, today, timeZone);
      result.reminded += reminded;
      if (request.due_on < today) result.overdueNotices += await this.overdue(trx, request);
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

  /** Reminds the pending people whose reminder date is in force (D.7). */
  private async remind(trx: Trx, request: OpenRequestRow, today: string, timeZone: string): Promise<number> {
    const startedOn = localDate(new Date(request.created_at), timeZone);
    const pending = await trx
      .selectFrom('acknowledgement')
      .select(['user_id', 'reminded_at', 'reminder_count'])
      .where('acknowledgement_request_id', '=', request.id)
      .where('status', '=', 'pending')
      .where('deleted_at', 'is', null)
      .execute();
    const due = pending
      .filter((p) => reminderDue({
        startedOn,
        dueOn: request.due_on,
        today,
        lastRemindedOn: p.reminded_at ? localDate(new Date(p.reminded_at), timeZone) : null,
        count: Number(p.reminder_count),
      }))
      .map((p) => p.user_id);
    if (due.length === 0) return 0;
    const reminded = await remindPending(trx, this.notifications, request, SYSTEM_USER_ID, due);
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

  /** `acknowledgement_overdue` in the digest of the system's Management System Managers, once per request. */
  private async overdue(trx: Trx, request: OpenRequestRow): Promise<number> {
    const [counts] = (await sql<{ pending: number }>`
      select count(*)::int as pending from acknowledgement where acknowledgement_request_id = ${request.id}::uuid and status = 'pending'
         and deleted_at is null`.execute(trx)).rows;
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

