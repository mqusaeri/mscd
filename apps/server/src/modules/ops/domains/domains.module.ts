import { Module } from '@nestjs/common';
import { DnsTxtChecker } from './dns-txt';
import { domainVerifyJobProvider } from './domain-verify.job';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';

/**
 * Email domain verification of the SaaS track (Milestone 2 K.6, M2-S11), a sub-module of `OpsModule` (D.3): the
 * operator routes of `ops.domains.*`, `DomainsService` (exported, so the operator command `tenant verify-domain` uses it
 * in multi tenancy), the DNS TXT lookups and the `domain.verify` job, which exists only in multi tenancy.
 */
@Module({
  controllers: [DomainsController],
  providers: [DnsTxtChecker, DomainsService, domainVerifyJobProvider],
  exports: [DnsTxtChecker, DomainsService],
})
export class DomainsModule {}
