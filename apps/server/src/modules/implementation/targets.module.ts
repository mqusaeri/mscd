import { Module } from '@nestjs/common';
import { DocumentedInfoController } from './documented-info.controller';
import { FreshnessThresholdsController } from './freshness-thresholds.controller';
import { TargetsController } from './targets.controller';

/**
 * Applicability targets, freshness thresholds per system and documented information (Milestone 2 D.1), a sub-module
 * of `ImplementationModule` (D.3). Written by M2-02 with the route stubs; M2-07 adds its services here and never edits
 * the parent module.
 */
@Module({
  controllers: [TargetsController, FreshnessThresholdsController, DocumentedInfoController],
})
export class TargetsModule {}
