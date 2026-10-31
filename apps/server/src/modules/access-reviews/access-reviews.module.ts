import { Module } from '@nestjs/common';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { AuditorAccessModule } from '../auditor-access/auditor-access.module';
import { FilesModule } from '../files/files.module';
import { TenantJobRunner } from '../jobs/tenant-job';
import { StorageModule } from '../storage/storage.module';
import { AccessReviewApplyService } from './access-review-apply.service';
import { AccessReviewOpenJob } from './access-review-open.job';
import { AccessReviewOpenService } from './access-review-open.service';
import { AccessReviewsController } from './access-reviews.controller';
import { AccessReviewsService } from './access-reviews.service';
import { MsAccessReviewsController } from './ms-access-reviews.controller';

/**
 * Periodic access review (Milestone 3 D.9, M3-07), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the organisation and of the system parts (`AccessReviewsService`,
 * `AccessReviewApplyService`) and the daily `access-review.open` job (`AccessReviewOpenService`). It imports
 * `AdminUsersModule` (users, role grants and linked sign-in) and `AuditorAccessModule` (guest grants) to apply decided
 * revocations through their services, `FilesModule` for `FileCommandsService.fileGeneratedEvidence` (each system's rows
 * filed as evidence at completion) and `StorageModule` for the report in the Managed Vault; `TenantJobRunner` keeps
 * no state and is provided here.
 */
@Module({
  imports: [AdminUsersModule, AuditorAccessModule, FilesModule, StorageModule],
  controllers: [AccessReviewsController, MsAccessReviewsController],
  providers: [AccessReviewsService, AccessReviewApplyService, AccessReviewOpenService, AccessReviewOpenJob, TenantJobRunner],
})
export class AccessReviewsModule {}
