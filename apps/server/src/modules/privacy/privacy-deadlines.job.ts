// `privacy.deadlines` job handler (Milestone 3 J.3, D.6.2): daily per organisation at 08:00 local through
// `scheduler.tick` (`pd:<org>:<local date>`). Each run notifies the active Tenant Admins (`privacy_request_due`) of every
// open request (received or in progress) that is due within 24 hours, and of every open request that is past its due
// time (each run again, until it is answered). The screens show the time left between runs.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { NOTIFICATION_WRITER, SYSTEM_USER_ID, type NotificationWriter, type TenantInfo, type Trx } from '../../common/tokens';
import { TenantJobRunner } from '../jobs/tenant-job';
import { activeTenantAdmins, requestRef } from './privacy-model';
import { dueNotice } from './privacy-text';

/** How long before its due time a request is announced as due soon (D.6.2). */
export const DUE_SOON_MS = 24 * 3_600_000;

export interface DeadlinesResult {
  dueSoon: number;
  overdue: number;
  notified: number;
}

@Injectable()
export class PrivacyDeadlinesService {
  constructor(@Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter) {}

  /** One run for an organisation at `now`, in its transaction as the system user. */
  async run(trx: Trx, org: TenantInfo, now: Date): Promise<DeadlinesResult> {
    const { rows } = await sql<{ id: string; request_no: string; request_type: 'access' | 'rectification' | 'restriction' | 'erasure'; due_at: Date }>`
      select r.id, r.request_no, r.request_type, r.due_at from privacy_request r
       where r.deleted_at is null and r.status in ('received', 'in_progress') and r.due_at <= ${new Date(now.getTime() + DUE_SOON_MS)}
       order by r.due_at, r.request_no`.execute(trx);
    if (rows.length === 0) return { dueSoon: 0, overdue: 0, notified: 0 };
    const admins = await activeTenantAdmins(trx, org.id);
    let dueSoon = 0;
    let overdue = 0;
    let notified = 0;
    for (const row of rows) {
      const late = new Date(row.due_at).getTime() <= now.getTime();
      if (late) overdue += 1;
      else dueSoon += 1;
      const notice = dueNotice(row.request_no, row.request_type, new Date(row.due_at), org.timeZone, late);
      for (const admin of admins) {
        const created = await this.notifications.create(trx, {
          recipientUserId: admin,
          kind: 'privacy_request_due',
          title: notice.title,
          body: notice.body,
          msId: null,
          ref: requestRef(row.id, row.request_no),
          createdBy: SYSTEM_USER_ID,
        });
        if (created) notified += 1;
      }
    }
    return { dueSoon, overdue, notified };
  }
}

@Injectable()
@JobHandler('privacy.deadlines', { concurrency: 1, scope: 'tenant' })
export class PrivacyDeadlinesJob implements JobHandlerInstance<'privacy.deadlines'> {
  private readonly logger = new Logger('privacy.deadlines');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly deadlines: PrivacyDeadlinesService,
  ) {}

  async handle(job: JobRun<'privacy.deadlines'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId);
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, localDate: job.env.payload.localDate ?? null, ...result }, 'privacy.deadlines done');
  }

  /** One run for an organisation; null when the organisation is gone or not active. */
  async run(orgId: string | null, requestId?: string): Promise<DeadlinesResult | null> {
    const org = await this.runner.organisation(orgId, 'privacy.deadlines');
    if (!org) return null;
    return this.runner.run(org, (trx) => this.deadlines.run(trx, org, this.clock.now()), requestId);
  }
}
