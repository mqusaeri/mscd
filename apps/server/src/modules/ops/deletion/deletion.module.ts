import { Module } from '@nestjs/common';
import { DeletionController } from './deletion.controller';
import { OrgLifecycleJob } from './org-lifecycle.job';
import { orgPurgeJobProvider } from './org-purge.job';

/**
 * End of contract and verified deletion of the SaaS track (Milestone 3 D.5), a sub-module of `OpsModule` (D.3): the
 * operator routes of `ops.deletion.*` and the `org.lifecycle` and `org.purge` jobs. `org.purge` exists only in multi
 * tenancy; `org.lifecycle` exists in both modes and does nothing in single tenancy (D.5.1). Written by M3-01 with a stub
 * controller and stub jobs; M3-03 adds its providers here.
 */
@Module({
  controllers: [DeletionController],
  providers: [OrgLifecycleJob, orgPurgeJobProvider],
})
export class DeletionModule {}
