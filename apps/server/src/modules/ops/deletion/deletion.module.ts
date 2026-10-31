import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { DeletionController } from './deletion.controller';
import { DeletionMailer } from './deletion-mailer';
import { DeletionService } from './deletion.service';
import { OrgLifecycleJob } from './org-lifecycle.job';
import { orgPurgeJobProvider } from './org-purge.job';
import { OrganizationTransitions } from './organization-transitions';
import { PurgeRunner } from './purge-runner';

/**
 * End of contract and verified deletion of the SaaS track (Milestone 3 D.5; M3-03), a sub-module of `OpsModule` (D.3):
 * the status moves of an organisation (`OrganizationTransitions`, which `OrganizationStatusService` of the parent module
 * and `org.lifecycle` share), the operator routes of `ops.deletion.*` (`DeletionService`), the purge (`PurgeRunner`,
 * with the storage gateway client of `StorageModule` for the vault step and `DeletionMailer` for the certificate email),
 * and the `org.lifecycle` and `org.purge` jobs. `org.purge` exists only in multi tenancy; `org.lifecycle` exists in both
 * modes and does nothing in single tenancy (D.5.1). Uses the global identity (anonymiser, session revocation, account
 * mailer), audit (writer, redactor, verifier), keys, tenancy and job queue providers.
 */
@Module({
  imports: [StorageModule],
  controllers: [DeletionController],
  providers: [OrganizationTransitions, DeletionService, DeletionMailer, PurgeRunner, OrgLifecycleJob, orgPurgeJobProvider],
  exports: [OrganizationTransitions, DeletionService, PurgeRunner],
})
export class DeletionModule {}
