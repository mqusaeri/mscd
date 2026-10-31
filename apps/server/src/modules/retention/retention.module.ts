import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { RetentionDisposal } from './retention-disposal';
import { RetentionReviewJob } from './retention-review.job';
import { RetentionReviewService } from './retention-review.service';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/**
 * Retention and disposal review (Milestone 3 D.8, M3-06), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of a system (`RetentionService`), the disposal effects (`RetentionDisposal`,
 * through the storage gateway) and the daily `retention.review` job (`RetentionReviewService`).
 */
@Module({
  imports: [StorageModule, JobsModule],
  controllers: [RetentionController],
  providers: [RetentionService, RetentionDisposal, RetentionReviewService, RetentionReviewJob],
  exports: [RetentionReviewService],
})
export class RetentionModule {}
