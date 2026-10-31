import { Module } from '@nestjs/common';
import { AccessReviewOpenJob } from './access-review-open.job';
import { AccessReviewsController } from './access-reviews.controller';
import { MsAccessReviewsController } from './ms-access-reviews.controller';

/**
 * Periodic access review (Milestone 3 D.9), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of the organisation and of the system parts and the `access-review.open` job.
 * Written by M3-01 with stub controllers and a stub job; M3-07 adds its providers here.
 */
@Module({
  controllers: [AccessReviewsController, MsAccessReviewsController],
  providers: [AccessReviewOpenJob],
})
export class AccessReviewsModule {}
