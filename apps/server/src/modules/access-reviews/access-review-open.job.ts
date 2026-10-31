// `access-review.open` job handler (Milestone 3 J.3, D.9): daily per organisation at 06:30 local through
// `scheduler.tick` (`ax:<org>:<local date>`), on the date of its run. Stub of M3-01, registered in
// access-reviews.module.ts; M3-07 fills it. A job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('access-review.open', { concurrency: 1, scope: 'tenant' })
export class AccessReviewOpenJob implements JobHandlerInstance<'access-review.open'> {
  private readonly logger = new Logger('access-review.open');

  async handle(job: JobRun<'access-review.open'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, localDate: job.env.payload.localDate ?? null },
      'access-review.open is not implemented in this build yet (M3-07); the job did nothing',
    );
  }
}
