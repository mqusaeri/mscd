// `applicability.sync` job handler (Milestone 2 J.3, E.3): after a pack installation updates an edition in use, adds
// entries for new catalogue items and leaf requirements and cycle items for new cycle requirements, never deletes.
// Stub of M2-02, registered in packs.module.ts; M2-03 fills it. Nothing queues the job before then; a job that
// arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('applicability.sync', { concurrency: 1, scope: 'tenant' })
export class ApplicabilitySyncJob implements JobHandlerInstance<'applicability.sync'> {
  private readonly logger = new Logger('applicability.sync');

  async handle(job: JobRun<'applicability.sync'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, frameworkVersionIds: job.env.payload.frameworkVersionIds },
      'applicability.sync is not implemented in this build yet (M2-03); the job did nothing',
    );
  }
}
