// `packs.lifecycle` (E.2): installation-wide, daily at 00:10 UTC (`PACKS_LIFECYCLE_CRON`, singleton `pl:<utc date>`).
// It also queues `applicability.sync` for systems still waiting for the content of an edition update, which covers
// installations made by `migrate` or `mscd-server packs install` (Milestone 2 E.3).
import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { ApplicabilitySyncService } from './applicability-sync.service';
import { PackLifecycleService } from './pack-lifecycle.service';

@Injectable()
@JobHandler('packs.lifecycle', { concurrency: 1, scope: 'installation' })
export class PacksLifecycleJob implements JobHandlerInstance<'packs.lifecycle'> {
  private readonly logger = new Logger('packs.lifecycle');

  constructor(
    private readonly lifecycle: PackLifecycleService,
    private readonly sync: ApplicabilitySyncService,
  ) {}

  async handle(job: JobRun<'packs.lifecycle'>): Promise<void> {
    const result = await this.lifecycle.runLifecycle(job.env.requestId);
    const synced = await this.sync.queuePending({ requestId: job.env.requestId });
    this.logger.log({ jobId: job.id, attempt: job.attempt, ...result, syncQueued: synced.organisations.length }, 'packs.lifecycle done');
  }
}
