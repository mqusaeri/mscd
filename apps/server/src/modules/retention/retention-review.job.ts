// `retention.review` job handler (Milestone 3 J.3, D.8): daily per organisation at 03:15 local through `scheduler.tick`
// (`rt:<org>:<local date>`), on the date of its run (`clock.runDate`). Runs `RetentionReviewService` in the organisation's
// transaction as the system user: the `replaced_at` backfill, new disposal reviews and the `retention_review_due` digest.
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { RetentionReviewService, type RetentionReviewResult } from './retention-review.service';

@Injectable()
@JobHandler('retention.review', { concurrency: 1, scope: 'tenant' })
export class RetentionReviewJob implements JobHandlerInstance<'retention.review'> {
  private readonly logger = new Logger('retention.review');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly review: RetentionReviewService,
  ) {}

  async handle(job: JobRun<'retention.review'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId, job.env.payload.localDate);
    this.logger.log(
      { jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, opened: result?.opened ?? 0, backfilled: result?.backfilled ?? 0 },
      'retention.review done',
    );
  }

  /** One run for an organisation on its local date; null when the organisation is gone or not active. */
  async run(orgId: string | null, requestId?: string, runLocalDate?: string): Promise<RetentionReviewResult | null> {
    const org = await this.runner.organisation(orgId, 'retention.review');
    if (!org) return null;
    const today = await this.clock.runDate(org.id, runLocalDate);
    return this.runner.run(org, (trx) => this.review.run(trx, org, today), requestId);
  }
}
