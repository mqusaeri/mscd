// `acknowledgement.reminders` job handler (Milestone 3 J.3, D.7): daily per organisation at 08:10 local through
// `scheduler.tick` (`ak:<org>:<local date>`), on the date of its run. Stub of M3-01, registered in
// acknowledgements.module.ts; M3-05 fills it. A job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('acknowledgement.reminders', { concurrency: 1, scope: 'tenant' })
export class AcknowledgementRemindersJob implements JobHandlerInstance<'acknowledgement.reminders'> {
  private readonly logger = new Logger('acknowledgement.reminders');

  async handle(job: JobRun<'acknowledgement.reminders'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, localDate: job.env.payload.localDate ?? null },
      'acknowledgement.reminders is not implemented in this build yet (M3-05); the job did nothing',
    );
  }
}
