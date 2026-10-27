import { Module } from '@nestjs/common';
import { ReadinessRecomputeJob } from './readiness-recompute.job';

/**
 * Clause readiness recompute (Milestone 2 D.6), a sub-module of `ImplementationModule` (D.3). Written by M2-02 with
 * the job stub; M2-05 adds its services here and never edits the parent module.
 */
@Module({
  providers: [ReadinessRecomputeJob],
})
export class ReadinessModule {}
