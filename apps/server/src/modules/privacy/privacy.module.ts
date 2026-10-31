import { Module } from '@nestjs/common';
import { ExportsModule } from '../exports/exports.module';
import { TenantJobRunner } from '../jobs/tenant-job';
import { HoldingsService } from '../registers/holdings.service';
import { MePrivacyController } from './me-privacy.controller';
import { MePrivacyService } from './me-privacy.service';
import { PersonExportController } from './person-export.controller';
import { PersonExportService } from './person-export.service';
import { PrivacyChecksController } from './privacy-checks.controller';
import { PrivacyChecksService } from './privacy-checks.service';
import { PrivacyDeadlinesJob, PrivacyDeadlinesService } from './privacy-deadlines.job';
import { PrivacyErasureService } from './privacy-erasure.service';
import { PrivacyRequestsController } from './privacy-requests.controller';
import { PrivacyRequestsService } from './privacy-requests.service';

/**
 * Requests from one person (Milestone 3 D.6), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the Tenant Admins, of the system checks and of the person, the person export
 * (through `ExportsService` of the exports module) and the `privacy.deadlines` job.
 *
 * `HoldingsService` (registers/holdings.service.ts) is provided here a second time for the open items check of an
 * erasure: it keeps no state and depends only on global providers, and the holdings sub-module does not export it.
 * `TenantJobRunner` is provided here as well, as it keeps no state.
 */
@Module({
  imports: [ExportsModule],
  controllers: [PrivacyRequestsController, PrivacyChecksController, MePrivacyController, PersonExportController],
  providers: [
    PrivacyRequestsService,
    PrivacyErasureService,
    PrivacyChecksService,
    MePrivacyService,
    PersonExportService,
    PrivacyDeadlinesService,
    PrivacyDeadlinesJob,
    HoldingsService,
    TenantJobRunner,
  ],
})
export class PrivacyModule {}
