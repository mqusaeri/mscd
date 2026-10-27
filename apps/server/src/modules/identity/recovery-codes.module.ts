import { Global, Module } from '@nestjs/common';
import { RecoveryCodesController } from './recovery-codes.controller';
import { RecoveryCodesService } from './recovery-codes.service';

/**
 * New recovery codes and the security overview of a signed-in user (Milestone 2 D.1), a sub-module of
 * `IdentityModule` (D.3). Global, so `MeService` of the authorisation module reads the security overview
 * (`GET /me/security`) without a change of the parent modules. Uses the exported identity services (sessions, MFA,
 * account mail) and the global tenancy, clock and audit providers.
 */
@Global()
@Module({
  controllers: [RecoveryCodesController],
  providers: [RecoveryCodesService],
  exports: [RecoveryCodesService],
})
export class RecoveryCodesModule {}
