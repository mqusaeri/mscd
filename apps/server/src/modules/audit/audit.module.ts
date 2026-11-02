import { Global, Module } from '@nestjs/common';
import { AUDIT_WRITER } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { trustedAnchorKeys } from './anchor-keys';
import { AuditRedactor } from './audit-redactor';
import { ChainedAuditWriter } from './audit-writer';
import { AuditTrailController } from './audit-trail.controller';
import { AuditTrailService } from './audit-trail.service';
import { AUDIT_ANCHOR_KEYS, AuditChainVerifier } from './chain-verifier';

/**
 * Audit trail writer, readers and chain verification for `platform.audit_log` and every tenant `audit_trail`, and
 * the signed anchors (F.11). The anchor job itself is WP-22's `audit.verify-chain`. Milestone 3 (D.5.4, M3-03): the
 * attested redaction (`AuditRedactor`), which the purge of an organisation and the erasure of a person (M3-04) use.
 * M3-12: the anchor checks trust the installation's own anchor keys as well as the compiled ones (`anchor-keys.ts`).
 */
@Global()
@Module({
  controllers: [AuditTrailController],
  providers: [
    ChainedAuditWriter,
    { provide: AUDIT_WRITER, useExisting: ChainedAuditWriter },
    // The compiled keys, the installation's signing key and its audit-anchor.pub (anchor-keys.ts, M3-12).
    { provide: AUDIT_ANCHOR_KEYS, useFactory: (config: MscdConfig) => trustedAnchorKeys(config), inject: [MscdConfig] },
    AuditChainVerifier,
    AuditTrailService,
    AuditRedactor,
  ],
  exports: [AUDIT_WRITER, AUDIT_ANCHOR_KEYS, AuditChainVerifier, AuditTrailService, AuditRedactor],
})
export class AuditModule {}
