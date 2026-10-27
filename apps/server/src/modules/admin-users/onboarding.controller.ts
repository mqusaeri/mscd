// `GET /admin/onboarding` (Milestone 2 D.1, D.5): the onboarding checklist of the organisation, states and counts only.
import { Controller } from '@nestjs/common';
import { adminOnboardingRoute, type OnboardingStep } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { OnboardingService } from './onboarding.service';

@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @ApiRoute(adminOnboardingRoute)
  checklist(@CurrentPrincipal() principal: Principal): Promise<OnboardingStep[]> {
    return this.onboarding.checklist(principal);
  }
}
