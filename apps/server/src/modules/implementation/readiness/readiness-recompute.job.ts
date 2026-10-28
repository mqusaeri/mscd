// `readiness.recompute` job handler (Milestone 2 J.3, D.6): clause readiness per system from documented information,
// implemented entries, fresh evidence and current metrics. Queued 60 seconds after the commands that feed it
// (`rr:<org>:<ms>`, `readiness-queue.ts`) and daily at 02:30 local time for every system (`rr:<org>:all`). Runs
// `ReadinessService` in the organisation's transaction as the system user.
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../../common/jobs/job-handler';
import type { JobRun } from '../../../common/jobs/job-queue';
import { TenantJobRunner } from '../../jobs/tenant-job';
import { ReadinessService, type SystemReadiness } from './readiness.service';

@Injectable()
@JobHandler('readiness.recompute', { concurrency: 2, scope: 'tenant' })
export class ReadinessRecomputeJob implements JobHandlerInstance<'readiness.recompute'> {
  private readonly logger = new Logger('readiness.recompute');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly readiness: ReadinessService,
  ) {}

  async handle(job: JobRun<'readiness.recompute'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.payload.msId ?? null, job.env.requestId, job.env.payload.localDate);
    this.logger.log(
      { jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, msId: job.env.payload.msId ?? null, systems: result.length },
      'readiness.recompute done',
    );
  }

  /**
   * One run for an organisation (`msId` null: every system) on its local date (the date of the run of
   * `scheduler.tick`, `runLocalDate`, Milestone 2 D.2).
   */
  async run(orgId: string | null, msId: string | null, requestId?: string, runLocalDate?: string): Promise<SystemReadiness[]> {
    const org = await this.runner.organisation(orgId, 'readiness.recompute');
    if (!org) return [];
    const today = await this.clock.runDate(org.id, runLocalDate);
    return this.runner.run(org, (trx) => this.readiness.recompute(trx, today, msId), requestId);
  }
}
