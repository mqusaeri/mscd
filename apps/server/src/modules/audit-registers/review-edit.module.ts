import { Module } from '@nestjs/common';
import { ReviewEditController } from './review-edit.controller';

/**
 * Management review changes (Milestone 2 D.1), a sub-module of `AuditRegistersModule` (D.3). Written by M2-02 with the
 * route stub; M2-07 adds its services here and never edits the parent module.
 */
@Module({
  controllers: [ReviewEditController],
})
export class ReviewEditModule {}
