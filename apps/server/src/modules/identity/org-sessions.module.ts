import { Module } from '@nestjs/common';

/**
 * Session revocation per organisation for the organisation lifecycle of the SaaS track (Milestone 2 K.6, M2-S09), a
 * sub-module of `IdentityModule` (D.3). Written empty by M2-02; M2-S09 adds `org-sessions.ts` and its providers here
 * and never edits the parent module.
 */
@Module({})
export class OrgSessionsModule {}
