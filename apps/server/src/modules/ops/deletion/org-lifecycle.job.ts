// `org.lifecycle` job handler (Milestone 3 J.3, D.5.1): hourly at minute 20 UTC in platform scope (the run ledger of
// the daily jobs skips organisations that are not active). Ends read-only periods, schedules deletions, sends the
// lifecycle reminders and queues `org.purge` when a deletion is due. Stub of M3-01, registered in deletion.module.ts;
// M3-03 fills it. A job that arrives is logged and completed.
//
// The organisation lifecycle belongs to multi tenancy. In single tenancy the job does nothing (D.5.1): the handler
// exists in both modes, so the operator console can run it (`ops.jobs.run`, D.2 adds it to `OPS_RUNNABLE_JOBS`) and
// its hourly schedule is registered, and a run with tenancy.mode single completes at once without any work.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';
import { MscdConfig } from '../../../config/mscd-config';

@Injectable()
@JobHandler('org.lifecycle', { concurrency: 1, scope: 'installation' })
export class OrgLifecycleJob implements JobHandlerInstance<'org.lifecycle'> {
  private readonly logger = new Logger('org.lifecycle');

  constructor(private readonly config: MscdConfig) {}

  async handle(job: JobRun<'org.lifecycle'>): Promise<void> {
    // Single tenancy: one organisation, no end of contract and no deletion (D.5.1). Nothing to do.
    if (this.config.profile.tenancy.mode !== 'multi') {
      this.logger.debug({ jobId: job.id }, 'org.lifecycle does nothing in single tenancy');
      return;
    }
    this.logger.warn({ jobId: job.id }, 'org.lifecycle is not implemented in this build yet (M3-03); the job did nothing');
  }
}
