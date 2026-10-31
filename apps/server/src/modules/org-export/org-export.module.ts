import { Module, type OnModuleInit } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { TenantCleanupRegistry } from '../jobs/tenant-cleanup';
import { StorageModule } from '../storage/storage.module';
import { OrgExportBuilder } from './builder';
import { EXPIRY_STATUSES, EXPORTS_EXPIRED_STEP, ExportExpiry } from './expiry';
import { OpsExportsController } from './ops-exports.controller';
import { OrgExportBuildJob } from './org-export-build.job';
import { OrgExportController } from './org-export.controller';
import { OrgExportService } from './org-export.service';

/**
 * Organisation export (Milestone 3 D.4, M3-02), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the Tenant Admins and of the platform operators, the builder of the parts
 * and the manifest, the `org-export.build` job, and the expiry of exports, registered as a tenant step of the hourly
 * `cleanup.expired` that runs for every organisation that is not deleted and deletes the vault content of expired
 * organisation exports and 7-day export files.
 */
@Module({
  imports: [StorageModule, JobsModule],
  controllers: [OrgExportController, OpsExportsController],
  providers: [OrgExportService, OrgExportBuilder, OrgExportBuildJob, ExportExpiry],
  exports: [OrgExportService, OrgExportBuilder, OrgExportBuildJob, ExportExpiry],
})
export class OrgExportModule implements OnModuleInit {
  constructor(
    private readonly cleanup: TenantCleanupRegistry,
    private readonly expiry: ExportExpiry,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: EXPORTS_EXPIRED_STEP, statuses: EXPIRY_STATUSES, run: (trx, orgId, now) => this.expiry.run(trx, orgId, now) });
  }
}
