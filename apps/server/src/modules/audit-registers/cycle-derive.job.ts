// `cycle.derive` job handler (E.2, Milestone 2 D.4): daily at 03:15 local time per organisation through
// `scheduler.tick` (`cd:<org>:all`) and after the commands that feed it (`cd:<org>:<ms>`: a management review closing,
// finding, corrective action, applicability, evidence and record commands, an internal audit report). Runs
// `CycleDeriveService` inside the organisation's transaction as the system user. Demo organisations
// (`demo_deploy_label` set) are skipped, as `applicability.sync` skips them, so the demo keeps matching the sample
// (G.9) when pack content carries derivations.
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
import { TenantJobRunner } from '../jobs/tenant-job';
import { CycleDeriveService, type CycleDeriveResult } from './cycle-derive.service';

@Injectable()
@JobHandler('cycle.derive', { concurrency: 2, scope: 'tenant' })
export class CycleDeriveJob implements JobHandlerInstance<'cycle.derive'> {
  private readonly logger = new Logger('cycle.derive');

  constructor(
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    private readonly derivation: CycleDeriveService,
  ) {}

  async handle(job: JobRun<'cycle.derive'>): Promise<void> {
    const result = await this.run(job.env.orgId, job.env.payload.msId ?? null, job.env.requestId);
    this.logger.log(
      {
        jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, systems: result.systems, items: result.items.length,
        done: result.items.filter((i) => i.changed).length, skipped: result.skipped.length,
      },
      'cycle.derive done',
    );
  }

  /** One run for an organisation (`msId` null: every system). */
  async run(orgId: string | null, msId: string | null, requestId?: string): Promise<CycleDeriveResult> {
    const org = await this.runner.organisation(orgId, 'cycle.derive');
    if (!org || org.demoDeployLabel) return { systems: 0, items: [], skipped: [] };
    const today = await this.clock.today(org.id);
    return this.runner.run(org, (trx) => this.derivation.derive(trx, today, msId), requestId);
  }
}
