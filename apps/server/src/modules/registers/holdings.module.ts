import { Module } from '@nestjs/common';
import { DocumentVersionsController } from './document-versions.controller';
import { DocumentVersionsService } from './documents.service';
import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';

/**
 * Holdings, handover and the document version history (Milestone 2 D.1), a sub-module of `RegistersModule` (D.3),
 * built by M2-07. Its services depend only on global providers (tenancy, record resolver, membership, scope policy,
 * rule engine, audit), so the parent module stays unchanged.
 */
@Module({
  controllers: [HoldingsController, DocumentVersionsController],
  providers: [HoldingsService, DocumentVersionsService],
})
export class HoldingsModule {}
