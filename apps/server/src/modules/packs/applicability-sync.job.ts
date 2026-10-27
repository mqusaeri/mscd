// `applicability.sync` job handler (Milestone 2 J.3, E.3; M2-03): after a pack installation updates an edition in use,
// adds the entries and cycle items of the new version to the organisation's systems on that edition, never deletes,
// tells their MS Managers and audits `pack.content_synced` (ApplicabilitySyncService). Demo organisations are skipped.
// Idempotent: a second run finds nothing waiting and does nothing.
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { ApplicabilitySyncService } from './applicability-sync.service';

@Injectable()
@JobHandler('applicability.sync', { concurrency: 1, scope: 'tenant' })
export class ApplicabilitySyncJob implements JobHandlerInstance<'applicability.sync'> {
  private readonly logger = new Logger('applicability.sync');

  constructor(private readonly sync: ApplicabilitySyncService) {}

  async handle(job: JobRun<'applicability.sync'>): Promise<void> {
    const result = await this.sync.sync(job.env.orgId, job.env.payload, job.env.requestId);
    this.logger.log(
      {
        jobId: job.id,
        orgId: job.env.orgId,
        attempt: job.attempt,
        packInstallId: job.env.payload.packInstallId ?? null,
        skipped: result.skipped ?? null,
        systems: result.systems.length,
        entries: result.systems.reduce((n, s) => n + s.entriesAdded.length, 0),
      },
      'applicability.sync done',
    );
  }
}
