import { Module } from '@nestjs/common';
import { ImportRunJob } from './import-run.job';
import { ImportsController } from './imports.controller';

/**
 * Bulk import of applicability entries, documents, risks and evidence (Milestone 2 D.1, D2-13), loaded by the api and
 * the worker (`API_FEATURE_MODULES`, `WORKER_FEATURE_MODULES`). Written by M2-02 as a skeleton with the route and job
 * stubs; M2-08 owns this folder from wave 3a and adds its services here.
 */
@Module({
  controllers: [ImportsController],
  providers: [ImportRunJob],
})
export class ImportsModule {}
