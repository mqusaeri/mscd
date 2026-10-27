// `entitlement.expiry` job handler (Milestone 2 J.3, K.6 M2-S10): daily emails before an entitlement ends. Stub of
// M2-02, registered in entitlements.module.ts; M2-S10 fills it. Until then a job is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('entitlement.expiry', { concurrency: 1, scope: 'installation' })
export class EntitlementExpiryJob implements JobHandlerInstance<'entitlement.expiry'> {
  private readonly logger = new Logger('entitlement.expiry');

  async handle(job: JobRun<'entitlement.expiry'>): Promise<void> {
    this.logger.warn({ jobId: job.id }, 'entitlement.expiry is not implemented in this build yet (M2-S10); the job did nothing');
  }
}
