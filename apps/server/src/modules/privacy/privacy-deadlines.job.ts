// `privacy.deadlines` job handler (Milestone 3 J.3, D.6.2): daily per organisation at 08:00 local through
// `scheduler.tick` (`pd:<org>:<local date>`), on the date of its run. Stub of M3-01, registered in privacy.module.ts;
// M3-04 fills it. A job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('privacy.deadlines', { concurrency: 1, scope: 'tenant' })
export class PrivacyDeadlinesJob implements JobHandlerInstance<'privacy.deadlines'> {
  private readonly logger = new Logger('privacy.deadlines');

  async handle(job: JobRun<'privacy.deadlines'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, localDate: job.env.payload.localDate ?? null },
      'privacy.deadlines is not implemented in this build yet (M3-04); the job did nothing',
    );
  }
}
