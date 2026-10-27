import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';

/**
 * Onboarding checklist (Milestone 2 D.5), a sub-module of `AdminUsersModule` (D.3). Written by M2-02 with the route
 * stub; M2-06 adds its services here and never edits the parent module.
 */
@Module({
  controllers: [OnboardingController],
})
export class OnboardingModule {}
