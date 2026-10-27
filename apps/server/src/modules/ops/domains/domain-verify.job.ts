// `domain.verify` job handler (Milestone 2 J.3, K.6 M2-S11): checks the TXT record of pending domains hourly for 7 days
// and of verified domains monthly. Stub of M2-02, registered in domains.module.ts; M2-S11 fills it. Until then a job
// is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';

@Injectable()
@JobHandler('domain.verify', { concurrency: 1, scope: 'installation' })
export class DomainVerifyJob implements JobHandlerInstance<'domain.verify'> {
  private readonly logger = new Logger('domain.verify');

  async handle(job: JobRun<'domain.verify'>): Promise<void> {
    this.logger.warn({ jobId: job.id, domain: job.env.payload.domain ?? null }, 'domain.verify is not implemented in this build yet (M2-S11); the job did nothing');
  }
}
