import { Module } from '@nestjs/common';
import { ManagementReviewEditService } from './management-reviews.service';
import { ReviewEditController } from './review-edit.controller';

/**
 * Management review changes (Milestone 2 D.1), a sub-module of `AuditRegistersModule` (D.3), built by M2-07. The
 * service depends only on global providers, so the parent module stays unchanged.
 */
@Module({
  controllers: [ReviewEditController],
  providers: [ManagementReviewEditService],
})
export class ReviewEditModule {}
