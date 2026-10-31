import { Module } from '@nestjs/common';
import { MePrivacyController } from './me-privacy.controller';
import { PersonExportController } from './person-export.controller';
import { PrivacyChecksController } from './privacy-checks.controller';
import { PrivacyDeadlinesJob } from './privacy-deadlines.job';
import { PrivacyRequestsController } from './privacy-requests.controller';

/**
 * Requests from one person (Milestone 3 D.6), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the Tenant Admins, of the system checks and of the person, the person export
 * and the `privacy.deadlines` job. Written by M3-01 with stub controllers and a stub job; M3-04 adds its providers here.
 */
@Module({
  controllers: [PrivacyRequestsController, PrivacyChecksController, MePrivacyController, PersonExportController],
  providers: [PrivacyDeadlinesJob],
})
export class PrivacyModule {}
