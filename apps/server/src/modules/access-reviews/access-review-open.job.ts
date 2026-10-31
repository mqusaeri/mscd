// `access-review.open` job handler (Milestone 3 J.3, D.9, M3-07): daily per organisation at 06:30 local through
// `scheduler.tick` (`ax:<org>:<local date>`), on the date of its run (`clock.runDate`). Runs
// `AccessReviewOpenService.daily` in the organisation's transaction as the system user: the settings row of an
// organisation that has none, a review when the due date has come and none is open, and the reminders of an open one
// (`access_review_due` three days before the due date, `access_review_overdue` every 7 days after it).
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { AccessReviewOpenService, type DailyResult } from './access-review-open.service';

@Injectable()
@JobHandler('access-review.open', { concurrency: 1, scope: 'tenant' })
export class AccessReviewOpenJob implements JobHandlerInstance<'access-review.open'> {
  private readonly logger = new Logger('access-review.open');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly opener: AccessReviewOpenService,
  ) {}

  async handle(job: JobRun<'access-review.open'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId, job.env.payload.localDate);
    this.logger.log(
      {
        jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, opened: result?.opened?.reviewNo ?? null, initialised: result?.initialised ?? false,
        dueSoonSent: result?.dueSoonSent ?? 0, overdueSent: result?.overdueSent ?? 0,
      },
      'access-review.open done',
    );
  }

  /** One run for an organisation on its local date; null when the organisation is gone or not active. */
  async run(orgId: string | null, requestId?: string, runLocalDate?: string): Promise<DailyResult | null> {
    const org = await this.runner.organisation(orgId, 'access-review.open');
    if (!org) return null;
    const today = await this.clock.runDate(org.id, runLocalDate);
    return this.runner.run(org, (trx) => this.opener.daily(trx, org, today), requestId);
  }
}
