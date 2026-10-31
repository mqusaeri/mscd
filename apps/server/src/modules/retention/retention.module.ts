import { Module } from '@nestjs/common';
import { RetentionReviewJob } from './retention-review.job';
import { RetentionController } from './retention.controller';

/**
 * Retention and disposal review (Milestone 3 D.8), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the routes of a system and the `retention.review` job. Written by M3-01 with a stub
 * controller and a stub job; M3-06 adds its providers here.
 */
@Module({
  controllers: [RetentionController],
  providers: [RetentionReviewJob],
})
export class RetentionModule {}
