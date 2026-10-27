import { Module } from '@nestjs/common';
import { ApplicabilityTargetsService } from './applicability.service';
import { DocumentedInfoController } from './documented-info.controller';
import { DocumentedInfoService } from './documented-info.service';
import { FreshnessThresholdsController } from './freshness-thresholds.controller';
import { FreshnessThresholdsService } from './freshness-thresholds.service';
import { TargetsController } from './targets.controller';

/**
 * Applicability targets, freshness thresholds per system and documented information (Milestone 2 D.1), a sub-module
 * of `ImplementationModule` (D.3), built by M2-07. Its services depend only on global providers (tenancy, record
 * resolver, scope policy, audit, job queue), so the parent module stays unchanged.
 */
@Module({
  controllers: [TargetsController, FreshnessThresholdsController, DocumentedInfoController],
  providers: [ApplicabilityTargetsService, FreshnessThresholdsService, DocumentedInfoService],
  exports: [DocumentedInfoService],
})
export class TargetsModule {}
