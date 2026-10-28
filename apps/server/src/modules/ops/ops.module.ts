import { Module } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';
import { DomainsModule } from './domains/domains.module';
import { OperatorAccountsService } from './operator-accounts.service';
import { OpsMetricsCollector } from './ops-metrics.collector';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { OrganizationStatusService } from './organization-status.service';
import { OpsOrganizationsService } from './organizations.service';
import { TenantDataKeys } from './tenant-data-keys';

/**
 * Platform operator endpoints and diagnostics (D.3 Operations, WP-34), plus the metrics of ARCHITECTURE 12 that
 * are read from the job queue and the database (api and worker). Uses the global tenancy, audit, licence, job
 * queue and platform providers. Milestone 2 (M2-06): the organisations of the operator (`OpsOrganizationsService`,
 * with `TenantDataKeys` for the data key of a new organisation) and the second-factor reset by email
 * (`OperatorAccountsService`), with the global identity services. Milestone 2 (M2-S09): the organisation lifecycle
 * (`OrganizationStatusService`, with `OrgSessions` of the identity sub-module, `EntitlementService` of the licence
 * sub-module and the change notice of M2-S10), the organisation detail and status history.
 */
@Module({
  // Milestone 2 sub-module (D.3): email domain verification of the SaaS track (M2-S11).
  imports: [DomainsModule],
  controllers: [OpsController],
  providers: [OpsMetricsCollector, OpsService, DiagnosticsService, OpsOrganizationsService, OrganizationStatusService, OperatorAccountsService, TenantDataKeys],
  exports: [OpsMetricsCollector, OpsService, DiagnosticsService, OpsOrganizationsService, OrganizationStatusService, TenantDataKeys],
})
export class OpsModule {}
