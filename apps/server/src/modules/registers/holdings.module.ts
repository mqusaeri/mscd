import { Module } from '@nestjs/common';
import { DocumentVersionsController } from './document-versions.controller';
import { HoldingsController } from './holdings.controller';

/**
 * Holdings, handover and the document version history (Milestone 2 D.1), a sub-module of `RegistersModule` (D.3).
 * Written by M2-02 with the route stubs; M2-07 adds its services here and never edits the parent module.
 */
@Module({
  controllers: [HoldingsController, DocumentVersionsController],
})
export class HoldingsModule {}
