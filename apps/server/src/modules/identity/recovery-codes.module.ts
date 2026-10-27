import { Module } from '@nestjs/common';
import { RecoveryCodesController } from './recovery-codes.controller';

/**
 * New recovery codes for a signed-in user (Milestone 2 D.1), a sub-module of `IdentityModule` (D.3). Written by M2-02
 * with the route stub; M2-06 adds its services here and never edits the parent module.
 */
@Module({
  controllers: [RecoveryCodesController],
})
export class RecoveryCodesModule {}
