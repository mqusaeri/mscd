import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import { JobsModule } from '../jobs/jobs.module';
import { TenantCleanupRegistry } from '../jobs/tenant-cleanup';
import { StorageModule } from '../storage/storage.module';
import { OrgExportBuilder } from './builder';
import { EXPIRY_STATUSES, EXPORTS_EXPIRED_STEP, ExportExpiry } from './expiry';
import { OpsExportsController } from './ops-exports.controller';
import { MIN_BUILD_CONNECTIONS, OrgExportBuildJob } from './org-export-build.job';
import { OrgExportController } from './org-export.controller';
import { OrgExportService } from './org-export.service';

/**
 * Organisation export (Milestone 3 D.4, M3-02), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the Tenant Admins and of the platform operators, the builder of the parts
 * and the manifest, the `org-export.build` job, and the expiry of exports, registered as a tenant step of the hourly
 * `cleanup.expired` that runs for every organisation that is not deleted and deletes the vault content of expired
 * organisation exports and 7-day export files.
 *
 * A worker whose `database.pool_max` is below the connections a build holds at once (`MIN_BUILD_CONNECTIONS`) logs a
 * warning at start; its builds fail with the reason (M3-15).
 */
@Module({
  imports: [StorageModule, JobsModule],
  controllers: [OrgExportController, OpsExportsController],
  providers: [OrgExportService, OrgExportBuilder, OrgExportBuildJob, ExportExpiry],
  exports: [OrgExportService, OrgExportBuilder, OrgExportBuildJob, ExportExpiry],
})
export class OrgExportModule implements OnModuleInit {
  private readonly logger = new Logger('org-export');

  constructor(
    private readonly cleanup: TenantCleanupRegistry,
    private readonly expiry: ExportExpiry,
    private readonly config: MscdConfig,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: EXPORTS_EXPIRED_STEP, statuses: EXPIRY_STATUSES, run: (trx, orgId, now) => this.expiry.run(trx, orgId, now) });
    this.warnSmallPool();
  }

  /** The start warning of a worker that cannot build an export (`database.pool_max` below `MIN_BUILD_CONNECTIONS`). */
  warnSmallPool(): boolean {
    const poolMax = this.config.profile.database.pool_max;
    if (this.config.runMode !== 'worker' || poolMax >= MIN_BUILD_CONNECTIONS) return false;
    this.logger.warn(
      { poolMax, needed: MIN_BUILD_CONNECTIONS },
      `database.pool_max is ${poolMax}: an organisation export build holds ${MIN_BUILD_CONNECTIONS} database connections at once ` +
        `(build lock, snapshot, one read), so every export request fails until database.pool_max is ${MIN_BUILD_CONNECTIONS} or more`,
    );
    return true;
  }
}
