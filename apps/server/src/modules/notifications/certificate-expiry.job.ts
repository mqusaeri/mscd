// `certificate.expiry` job handler (Milestone 2 J.3, D.4): daily per organisation, notices 90, 30 and 7 days before
// a certificate expires and the move of a lapsed cycle to `expired`. Stub of M2-02, registered in
// management-systems/certification.module.ts; M2-05 fills it. Until then a job is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('certificate.expiry', { concurrency: 1, scope: 'tenant' })
export class CertificateExpiryJob implements JobHandlerInstance<'certificate.expiry'> {
  private readonly logger = new Logger('certificate.expiry');

  async handle(job: JobRun<'certificate.expiry'>): Promise<void> {
    this.logger.warn({ jobId: job.id, orgId: job.env.orgId }, 'certificate.expiry is not implemented in this build yet (M2-05); the job did nothing');
  }
}
