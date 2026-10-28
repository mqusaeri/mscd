import { Global, Module } from '@nestjs/common';
import { LICENCE_GATE } from '../../common/tokens';
import { ORG_RATE_LIMITS } from '../tenancy/rate-limit-store';
import { EntitlementRegistry } from './entitlement-registry';
import { EntitlementStore } from './entitlement-store';
import { EntitlementsModule } from './entitlements.module';
import { LicenseCheckJob } from './license-check.job';
import { LicenseController } from './license.controller';
import { LicenceGateService } from './licence-gate';
import { LicenceService } from './licence.service';
import { TenantChangeListener } from './tenant-change';
import { TRUST_ANCHORS, compiledTrustAnchors } from './trust-anchors';

/**
 * Licence verification with the compiled trust anchors, derived licence state and the real `LICENCE_GATE` (D-15,
 * D-16, D-32, BR-37), `GET /license`, `PUT /admin/license` and the `license.check` job. Global: the guard and every
 * module that checks a limit or feature inject `LICENCE_GATE`; the pack installer uses `TRUST_ANCHORS`.
 *
 * Milestone 2 (M2-S10): the entitlement rows of multi tenancy (`EntitlementStore` writes them, `EntitlementRegistry`
 * caches them, also as the `ORG_RATE_LIMITS` of the rate limits), the change notices across processes
 * (`TenantChangeListener`, `publishTenantChange`), and the sub-module with the operator routes, `EntitlementService`
 * and the `entitlement.expiry` job.
 */
@Global()
@Module({
  // Milestone 2 sub-module (D.3): per-organisation entitlements of the SaaS track (M2-S10).
  imports: [EntitlementsModule],
  controllers: [LicenseController],
  providers: [
    { provide: TRUST_ANCHORS, useFactory: compiledTrustAnchors },
    LicenceService,
    LicenceGateService,
    { provide: LICENCE_GATE, useExisting: LicenceGateService },
    LicenseCheckJob,
    TenantChangeListener,
    EntitlementRegistry,
    { provide: ORG_RATE_LIMITS, useExisting: EntitlementRegistry },
    EntitlementStore,
  ],
  exports: [LICENCE_GATE, LicenceService, TRUST_ANCHORS, TenantChangeListener, EntitlementRegistry, ORG_RATE_LIMITS, EntitlementStore, EntitlementsModule],
})
export class LicenseModule {}
