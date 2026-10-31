import { Module } from '@nestjs/common';
import { OpsExportsController } from './ops-exports.controller';
import { OrgExportBuildJob } from './org-export-build.job';
import { OrgExportController } from './org-export.controller';

/**
 * Organisation export (Milestone 3 D.4), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the Tenant Admins and of the platform operators and the `org-export.build`
 * job. Written by M3-01 with stub controllers and a stub job; M3-02 adds its providers here.
 */
@Module({
  controllers: [OrgExportController, OpsExportsController],
  providers: [OrgExportBuildJob],
})
export class OrgExportModule {}
