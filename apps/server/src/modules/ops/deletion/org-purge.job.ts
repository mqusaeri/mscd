// `org.purge` job handler (Milestone 3 J.3, D.5.2 to D.5.5): runs one deletion from its first or its failed step, in
// platform scope. Queued by `org.lifecycle`, `ops.deletion.retry` and `tenant deletion run`. Stub of M3-01, registered
// in deletion.module.ts; M3-03 fills it. Nothing queues the job before then; a job that arrives is logged and
// completed.
//
// Verified deletion belongs to multi tenancy (the deletion routes answer 409 `single_tenancy` in single tenancy,
// D.5.1), so the handler exists only there: `orgPurgeJobProvider` gives no instance in single tenancy.
import { Injectable, Logger, type FactoryProvider } from '@nestjs/common';
import { JOB_HANDLER_METADATA, JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';
import { MscdConfig } from '../../../config/mscd-config';

@Injectable()
@JobHandler('org.purge', { concurrency: 1, scope: 'installation' })
export class OrgPurgeJob implements JobHandlerInstance<'org.purge'> {
  private readonly logger = new Logger('org.purge');

  async handle(job: JobRun<'org.purge'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, deletionId: job.env.payload.deletionId },
      'org.purge is not implemented in this build yet (M3-03); the job did nothing',
    );
  }
}

/**
 * The provider of the handler: an instance with tenancy.mode multi, none (null) in single tenancy. The handler registry
 * reads the `@JobHandler` metadata from a provider's metatype, which for a factory provider is the factory, so the
 * factory carries the class's metadata; with a null instance the registry skips the provider.
 */
function createOrgPurgeJob(config: MscdConfig): OrgPurgeJob | null {
  return config.profile.tenancy.mode === 'multi' ? new OrgPurgeJob() : null;
}
Reflect.defineMetadata(JOB_HANDLER_METADATA, Reflect.getMetadata(JOB_HANDLER_METADATA, OrgPurgeJob), createOrgPurgeJob);

export const orgPurgeJobProvider: FactoryProvider<OrgPurgeJob | null> = {
  provide: OrgPurgeJob,
  useFactory: createOrgPurgeJob,
  inject: [MscdConfig],
};
