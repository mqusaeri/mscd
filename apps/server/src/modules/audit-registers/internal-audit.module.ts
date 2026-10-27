import { Module } from '@nestjs/common';
import { InternalAuditController } from './internal-audit.controller';

/**
 * Internal audit programme (Milestone 2 D.1), a sub-module of `AuditRegistersModule` (D.3). Written by M2-02 with the
 * route stub; M2-05 adds its services here and never edits the parent module.
 */
@Module({
  controllers: [InternalAuditController],
})
export class InternalAuditModule {}
