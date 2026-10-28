// `certificate.expiry` job handler (Milestone 2 J.3, D.4): daily per organisation in local time through
// `scheduler.tick` (`ce:<org>:<local date>`). Runs `CertificateExpiryService` in the organisation's transaction as the
// system user: notices 90, 30 and 7 days before a certificate expires, and the move of a lapsed cycle to `expired`.
// Registered in management-systems/certification.module.ts with the certification services.
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { CertificateExpiryService, type CertificateExpiryResult } from '../management-systems/certification.expiry';

@Injectable()
@JobHandler('certificate.expiry', { concurrency: 1, scope: 'tenant' })
export class CertificateExpiryJob implements JobHandlerInstance<'certificate.expiry'> {
  private readonly logger = new Logger('certificate.expiry');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly expiry: CertificateExpiryService,
  ) {}

  async handle(job: JobRun<'certificate.expiry'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.requestId, job.env.payload.localDate);
    this.logger.log(
      { jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, notified: result?.notified ?? 0, expired: result?.expired.length ?? 0 },
      'certificate.expiry done',
    );
  }

  /**
   * One run for an organisation on its local date (the date of the run of `scheduler.tick`, `runLocalDate`, Milestone 2
   * D.2); null when the organisation is gone or not active.
   */
  async run(orgId: string | null, requestId?: string, runLocalDate?: string): Promise<CertificateExpiryResult | null> {
    const org = await this.runner.organisation(orgId, 'certificate.expiry');
    if (!org) return null;
    const today = await this.clock.runDate(org.id, runLocalDate);
    return this.runner.run(org, (trx) => this.expiry.run(trx, today), requestId);
  }
}
