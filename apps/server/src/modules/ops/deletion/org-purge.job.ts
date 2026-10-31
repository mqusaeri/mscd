// `org.purge` job handler (Milestone 3 J.3, D.5.2 to D.5.5; M3-03): runs one deletion from its first or its failed step,
// in platform scope, through `PurgeRunner`. Queued by `org.lifecycle` on the deletion date, by `ops.deletion.retry`, by
// `tenant deletion run` (a due deletion) and by `tenant purge --reapply` (after a restore, D.5.6). One purge runs at a
// time in the installation (the runner holds an advisory lock).
//
// Verified deletion belongs to multi tenancy (the deletion routes answer 409 `single_tenancy` in single tenancy,
// D.5.1), so the handler exists only there: `orgPurgeJobProvider` gives no instance in single tenancy.
import { Injectable, Logger, type FactoryProvider } from '@nestjs/common';
import { JOB_HANDLER_METADATA, JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';
import { MscdConfig } from '../../../config/mscd-config';
import { PurgeRunner } from './purge-runner';

@Injectable()
@JobHandler('org.purge', { concurrency: 1, scope: 'installation' })
export class OrgPurgeJob implements JobHandlerInstance<'org.purge'> {
  private readonly logger = new Logger('org.purge');

  constructor(private readonly runner: PurgeRunner) {}

  async handle(job: JobRun<'org.purge'>): Promise<void> {
    const deletionId = job.env.payload.deletionId;
    const result = await this.runner.run(deletionId, job.env.requestId);
    this.logger.log({ jobId: job.id, deletionId, status: result.status, failedStep: result.failedStep }, 'org.purge done');
  }
}

/**
 * The provider of the handler: an instance with tenancy.mode multi, none (null) in single tenancy. The handler registry
 * reads the `@JobHandler` metadata from a provider's metatype, which for a factory provider is the factory, so the
 * factory carries the class's metadata; with a null instance the registry skips the provider.
 */
function createOrgPurgeJob(config: MscdConfig, runner: PurgeRunner): OrgPurgeJob | null {
  return config.profile.tenancy.mode === 'multi' ? new OrgPurgeJob(runner) : null;
}
Reflect.defineMetadata(JOB_HANDLER_METADATA, Reflect.getMetadata(JOB_HANDLER_METADATA, OrgPurgeJob), createOrgPurgeJob);

export const orgPurgeJobProvider: FactoryProvider<OrgPurgeJob | null> = {
  provide: OrgPurgeJob,
  useFactory: createOrgPurgeJob,
  inject: [MscdConfig, PurgeRunner],
};
