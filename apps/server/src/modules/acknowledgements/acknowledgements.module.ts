import { Module } from '@nestjs/common';
import { AcknowledgementRemindersJob } from './acknowledgement-reminders.job';
import { AcknowledgementRequestsController } from './acknowledgement-requests.controller';
import { MeAcknowledgementsController } from './me-acknowledgements.controller';

/**
 * Read confirmation of policies (Milestone 3 D.7), loaded by the api and the worker (`API_FEATURE_MODULES`,
 * `WORKER_FEATURE_MODULES`): the requests of a system, the person's own confirmations and the
 * `acknowledgement.reminders` job. Written by M3-01 with stub controllers and a stub job; M3-05 adds its providers here.
 */
@Module({
  controllers: [AcknowledgementRequestsController, MeAcknowledgementsController],
  providers: [AcknowledgementRemindersJob],
})
export class AcknowledgementsModule {}
