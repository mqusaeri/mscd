import { Module } from '@nestjs/common';
import { AcknowledgementsModule } from '../acknowledgements/acknowledgements.module';
import { ReadModelModule } from '../read-model/read-model.module';
import { AuditEventCommandsService } from './audit-events.service';
import { DocumentCommandsService } from './documents.service';
import { HoldingsModule } from './holdings.module';
import { RecordCommandsService } from './records.service';
import { REGISTER_RULES } from './register.rules';
import { RegistersController } from './registers.controller';
import { SharedChangeGuard } from './shared-change';

/**
 * Documents, assignment, complete-action, soft delete, audit events, preparation tasks, cycle items and task
 * completion (D.3, C.13, WP-35), with the rules they trigger (BR-16, BR-22, BR-41, BR-42, BR-43) registered with
 * `@BusinessRule` for the global `RuleEngine`. `SharedChangeGuard` (BR-22) is exported for the register edits of
 * WP-36 and WP-37.
 */
@Module({
  // Milestone 2 sub-module (D.3): holdings, handover and the document version history (M2-07). Milestone 3 (D.7, M3-05):
  // the approval of a document version opens its read confirmation request through `AcknowledgementService`.
  imports: [ReadModelModule, HoldingsModule, AcknowledgementsModule],
  controllers: [RegistersController],
  providers: [RecordCommandsService, DocumentCommandsService, AuditEventCommandsService, SharedChangeGuard, ...REGISTER_RULES],
  exports: [RecordCommandsService, DocumentCommandsService, AuditEventCommandsService, SharedChangeGuard],
})
export class RegistersModule {}
