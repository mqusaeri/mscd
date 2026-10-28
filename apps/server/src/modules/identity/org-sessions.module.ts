import { Global, Module } from '@nestjs/common';
import { OrgSessions } from './org-sessions';

/**
 * Session revocation per organisation for the organisation lifecycle of the SaaS track (Milestone 2 K.6, M2-S09), a
 * sub-module of `IdentityModule` (D.3). Global, so the operator's status change (`ops/organization-status.service.ts`)
 * and the command line inject `OrgSessions` without a change of the parent modules. Uses the global clock.
 */
@Global()
@Module({
  providers: [OrgSessions],
  exports: [OrgSessions],
})
export class OrgSessionsModule {}
