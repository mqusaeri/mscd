import { Module } from '@nestjs/common';
import { EntitlementExpiryJob } from './entitlement-expiry.job';
import { EntitlementsController } from './entitlements.controller';

/**
 * Per-organisation entitlements, plan presets and the `entitlement.expiry` job (Milestone 2 K.6, M2-S10), a sub-module
 * of `LicenseModule` (D.3). Written by M2-02 with the route and job stubs; M2-S10 adds its services here.
 */
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementExpiryJob],
})
export class EntitlementsModule {}
