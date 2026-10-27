// `import.run` job handler (Milestone 2 J.3, D2-13): applies every row of a checked import in one transaction through
// the existing command services. Stub of M2-02, registered in imports.module.ts; M2-08 fills it. Nothing queues the
// job before then; a job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('import.run', { concurrency: 1, scope: 'tenant' })
export class ImportRunJob implements JobHandlerInstance<'import.run'> {
  private readonly logger = new Logger('import.run');

  async handle(job: JobRun<'import.run'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, importId: job.env.payload.importId },
      'import.run is not implemented in this build yet (M2-08); the job did nothing',
    );
  }
}
