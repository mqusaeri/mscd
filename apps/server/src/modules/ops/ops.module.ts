import { Module } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';
import { DomainsModule } from './domains/domains.module';
import { OpsMetricsCollector } from './ops-metrics.collector';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

/**
 * Platform operator endpoints and diagnostics (D.3 Operations, WP-34), plus the metrics of ARCHITECTURE 12 that
 * are read from the job queue and the database (api and worker). Uses the global tenancy, audit, licence, job
 * queue and platform providers.
 */
@Module({
  // Milestone 2 sub-module (D.3): email domain verification of the SaaS track (M2-S11).
  imports: [DomainsModule],
  controllers: [OpsController],
  providers: [OpsMetricsCollector, OpsService, DiagnosticsService],
  exports: [OpsMetricsCollector, OpsService, DiagnosticsService],
})
export class OpsModule {}
