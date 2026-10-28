import { Module } from '@nestjs/common';
import { entitlementExpiryJobProvider } from './entitlement-expiry.job';
import { EntitlementService } from './entitlement.service';
import { EntitlementsController } from './entitlements.controller';

/**
 * Per-organisation entitlements, plan presets and the `entitlement.expiry` job (Milestone 2 K.6, M2-S10), a sub-module
 * of `LicenseModule` (D.3). The operator routes, `EntitlementService` (exported, and re-exported by the global
 * `LicenseModule`, so M2-S09 calls `applyPreset` from the operator services) and the expiry job, which exists only in
 * multi tenancy. The row store, the registry and the change listener live in `LicenseModule`, because
 * `LicenceService` reads them.
 */
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementService, entitlementExpiryJobProvider],
  exports: [EntitlementService],
})
export class EntitlementsModule {}
