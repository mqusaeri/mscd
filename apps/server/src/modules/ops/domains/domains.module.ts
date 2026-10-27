import { Module } from '@nestjs/common';
import { DomainVerifyJob } from './domain-verify.job';
import { DomainsController } from './domains.controller';

/**
 * Email domain verification of the SaaS track (Milestone 2 K.6, M2-S11), a sub-module of `OpsModule` (D.3). Written by
 * M2-02 with the route and job stubs; M2-S11 owns `ops/domains/**` from wave 3b and adds its services here.
 */
@Module({
  controllers: [DomainsController],
  providers: [DomainVerifyJob],
})
export class DomainsModule {}
