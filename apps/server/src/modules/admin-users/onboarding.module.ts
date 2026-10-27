import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding checklist (Milestone 2 D.5), a sub-module of `AdminUsersModule` (D.3): `GET /admin/onboarding`, computed
 * by `OnboardingService` from existing tables. Uses the global tenancy, clock and configuration providers, and the
 * licence service when the application loads the licence module.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
