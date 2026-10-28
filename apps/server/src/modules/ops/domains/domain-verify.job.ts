// `domain.verify` (Milestone 2 J.3, K.6, M2-S11): installation-wide, on the cron schedule of `schedules.ts` (hourly at
// minute 35, UTC) and once a minute after `ops.domains.add` for the new domain.
// - Without a payload: the sweep of `DomainsService.sweep`: every pending DNS domain is checked; one past its 7 days
//   becomes failed (audited `ops.domain_verification_failed`); a found record verifies it (`ops.domain_verified`).
//   Verified DNS domains whose last check is 30 days old are checked again; when the record is gone the platform
//   operators get the `domain_record_missing` email and the domain stays verified.
// - With `{organizationId, domain}`: that domain only, while it is pending.
// A lookup that no resolver answers changes nothing (the next hour tries again), except that a pending domain past
// its 7 days still ends.
//
// Domains are verified by DNS in multi tenancy only (single tenancy keeps `tenant verify-domain`), so the handler
// exists only there: `domainVerifyJobProvider` gives no instance in single tenancy, and the worker registers the
// cron schedule only for jobs it handles.
import { Injectable, Logger, type FactoryProvider } from '@nestjs/common';
import { JOB_HANDLER_METADATA, JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';
import { MscdConfig } from '../../../config/mscd-config';
import { DomainsService } from './domains.service';

@Injectable()
@JobHandler('domain.verify', { concurrency: 1, scope: 'installation' })
export class DomainVerifyJob implements JobHandlerInstance<'domain.verify'> {
  private readonly logger = new Logger('domain.verify');

  constructor(private readonly domains: DomainsService) {}

  async handle(job: JobRun<'domain.verify'>): Promise<void> {
    const { organizationId, domain } = job.env.payload;
    if (organizationId && domain) {
      const outcome = await this.domains.checkOne(organizationId, domain);
      this.logger.log({ jobId: job.id, orgId: organizationId, domain, check: outcome?.check ?? 'not_pending', to: outcome?.to ?? null }, 'domain.verify: one domain checked');
      return;
    }
    const result = await this.domains.sweep();
    this.logger.log({ jobId: job.id, ...result }, 'domain.verify: sweep done');
  }
}

/**
 * The provider of the handler: an instance with tenancy.mode multi, none (null) in single tenancy. The handler registry
 * reads the `@JobHandler` metadata from a provider's metatype, which for a factory provider is the factory, so the
 * factory carries the class's metadata; with a null instance the registry skips the provider.
 */
function createDomainVerifyJob(config: MscdConfig, domains: DomainsService): DomainVerifyJob | null {
  return config.profile.tenancy.mode === 'multi' ? new DomainVerifyJob(domains) : null;
}
Reflect.defineMetadata(JOB_HANDLER_METADATA, Reflect.getMetadata(JOB_HANDLER_METADATA, DomainVerifyJob), createDomainVerifyJob);

export const domainVerifyJobProvider: FactoryProvider<DomainVerifyJob | null> = {
  provide: DomainVerifyJob,
  useFactory: createDomainVerifyJob,
  inject: [MscdConfig, DomainsService],
};
