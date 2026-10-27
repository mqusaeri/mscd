import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { ReadinessRecomputeJob } from './readiness-recompute.job';
import { ReadinessService } from './readiness.service';

/**
 * Clause readiness recompute (Milestone 2 D.6, M2-05), a sub-module of `ImplementationModule` (D.3): the
 * `readiness.recompute` job and the service that computes and stores the four dimensions per clause group. The
 * commands queue the job through `readiness-queue.ts`.
 */
@Module({
  imports: [JobsModule],
  providers: [ReadinessService, ReadinessRecomputeJob],
  exports: [ReadinessService],
})
export class ReadinessModule {}
