import { Module } from '@nestjs/common';
import { JOB_QUEUE } from '../../common/jobs/job-queue';
import { AUDIT_WRITER } from '../../common/tokens';
import { ApplicabilityService } from '../implementation/applicability.service';
import { DocumentCommandsService } from '../registers/documents.service';
import { SharedChangeGuard } from '../registers/shared-change';
import { EvidenceService } from '../risk-registers/evidence.service';
import { RegistersService } from '../risk-registers/registers.service';
import { TenantScope } from '../tenancy/tenant-scope';
import { ImportHold, ImportSharedModule } from './import-hold';
import { ImportRunJob } from './import-run.job';
import { ImportTenantScope } from './import-tenant-scope';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Bulk import of applicability entries, documents, risks and evidence (Milestone 2 D.1, D2-13), loaded by the api and
 * the worker (`API_FEATURE_MODULES`, `WORKER_FEATURE_MODULES`). Written by M2-02 as a skeleton; built by M2-08.
 *
 * The commit applies every row in one transaction through the existing command services (D2-13). The module gives
 * its own instances of those services:
 * - `ImportTenantScope` as their `TenantScope` (a provider of this module wins over the global one), so inside
 *   `inOneTransaction` each command joins the import's transaction; everywhere else the scope opens a transaction per
 *   call as `TenantScope` does;
 * - the audit writer and the job queue of `ImportHold`, which keep the audit entries and the per-system recompute jobs
 *   of a commit until its rows are in (import-hold.ts), so the commit holds the organisation's audit chain only for
 *   its last statements; everywhere else they are the application's own.
 * The services and the rules they run are unchanged: the rules stay registered once, in their own modules, for the
 * global rule engine.
 */
@Module({
  imports: [ImportSharedModule],
  controllers: [ImportsController],
  providers: [
    ImportTenantScope,
    { provide: TenantScope, useExisting: ImportTenantScope },
    ImportHold,
    { provide: AUDIT_WRITER, inject: [ImportHold], useFactory: (hold: ImportHold) => hold.auditWriter },
    { provide: JOB_QUEUE, inject: [ImportHold], useFactory: (hold: ImportHold) => hold.jobQueue },
    ApplicabilityService,
    DocumentCommandsService,
    SharedChangeGuard,
    RegistersService,
    EvidenceService,
    ImportsService,
    ImportRunJob,
  ],
})
export class ImportsModule {}
