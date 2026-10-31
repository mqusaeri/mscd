// `retention.review` job handler (Milestone 3 J.3, D.8): daily per organisation at 03:15 local through `scheduler.tick`
// (`rt:<org>:<local date>`), on the date of its run. Stub of M3-01, registered in retention.module.ts; M3-06 fills it.
// A job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('retention.review', { concurrency: 1, scope: 'tenant' })
export class RetentionReviewJob implements JobHandlerInstance<'retention.review'> {
  private readonly logger = new Logger('retention.review');

  async handle(job: JobRun<'retention.review'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, localDate: job.env.payload.localDate ?? null },
      'retention.review is not implemented in this build yet (M3-06); the job did nothing',
    );
  }
}
