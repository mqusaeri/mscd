// `org-export.build` job handler (Milestone 3 J.3, D.4): builds the parts and the manifest of one organisation export
// and stores them in the vault. Queued by `exports.organization.create` and `.decide`, `ops.exports.create` and the move
// to `offboarding`; one build per installation at a time. Stub of M3-01, registered in org-export.module.ts; M3-02
// fills it. Nothing queues the job before then; a job that arrives is logged and completed.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';

@Injectable()
@JobHandler('org-export.build', { concurrency: 1, scope: 'tenant' })
export class OrgExportBuildJob implements JobHandlerInstance<'org-export.build'> {
  private readonly logger = new Logger('org-export.build');

  async handle(job: JobRun<'org-export.build'>): Promise<void> {
    this.logger.warn(
      { jobId: job.id, orgId: job.env.orgId, exportId: job.env.payload.exportId },
      'org-export.build is not implemented in this build yet (M3-02); the job did nothing',
    );
  }
}
