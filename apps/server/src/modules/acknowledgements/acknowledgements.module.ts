import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { RedirectTokens } from '../files/redirect-token';
import { TenantJobRunner } from '../jobs/tenant-job';
import { StorageModule } from '../storage/storage.module';
import { AcknowledgementRemindersJob } from './acknowledgement-reminders.job';
import { AcknowledgementRequestsController } from './acknowledgement-requests.controller';
import { AcknowledgementRequestsService } from './acknowledgement-requests.service';
import { AcknowledgementService } from './acknowledgement.service';
import { MeAcknowledgementsController } from './me-acknowledgements.controller';
import { MeAcknowledgementsService } from './me-acknowledgements.service';

/**
 * Read confirmation of policies (Milestone 3 D.7), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the requests of a system, the person's own confirmations and the
 * `acknowledgement.reminders` job. `AcknowledgementService` is exported for the approval of a document version
 * (`registers/registers.module.ts` imports this module; this module imports nothing from `registers/`). It imports
 * `FilesModule` for `FileCommandsService.fileGeneratedEvidence` (close and file the register) and `StorageModule` for
 * the provider address of a file kept in the customer's repository; `RedirectTokens` and `TenantJobRunner` are
 * provided here as well, as they keep no state.
 */
@Module({
  imports: [FilesModule, StorageModule],
  controllers: [AcknowledgementRequestsController, MeAcknowledgementsController],
  providers: [
    AcknowledgementService,
    AcknowledgementRequestsService,
    MeAcknowledgementsService,
    AcknowledgementRemindersJob,
    RedirectTokens,
    TenantJobRunner,
  ],
  exports: [AcknowledgementService],
})
export class AcknowledgementsModule {}
