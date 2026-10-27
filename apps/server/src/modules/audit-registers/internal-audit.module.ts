import { Module } from '@nestjs/common';
import { InternalAuditController } from './internal-audit.controller';
import { AudIndepRule } from './internal-audit.rules';
import { InternalAuditService } from './internal-audit.service';

/**
 * Internal audit programme (Milestone 2 D.1) and the auditor independence warning `AUD-INDEP` (D.2), a sub-module of
 * `AuditRegistersModule` (D.3), built by M2-05. The rule is found by the global `RuleEngine` through `@BusinessRule`.
 */
@Module({
  controllers: [InternalAuditController],
  providers: [InternalAuditService, AudIndepRule],
  exports: [InternalAuditService],
})
export class InternalAuditModule {}
