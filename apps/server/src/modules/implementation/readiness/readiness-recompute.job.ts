// `readiness.recompute` job handler (Milestone 2 J.3, D.6): clause readiness per system from documented information,
// implemented entries, fresh evidence and current metrics. Stub of M2-02, registered in readiness.module.ts; M2-05
// fills it. Until then a job is logged and completed, and clause readiness keeps its stored rows.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';

@Injectable()
@JobHandler('readiness.recompute', { concurrency: 2, scope: 'tenant' })
export class ReadinessRecomputeJob implements JobHandlerInstance<'readiness.recompute'> {
  private readonly logger = new Logger('readiness.recompute');

  async handle(job: JobRun<'readiness.recompute'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, msId: job.env.payload.msId ?? null },
      'readiness.recompute is not implemented in this build yet (M2-05); the job did nothing',
    );
  }
}
