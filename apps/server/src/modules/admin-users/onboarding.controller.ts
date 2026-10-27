// `GET /admin/onboarding` (Milestone 2 D.1, D.5): the onboarding checklist of the organisation. Stub of M2-02, answering
// 501 `not-implemented` after the guard; M2-06 replaces it and registers its services in onboarding.module.ts.
import { Controller } from '@nestjs/common';
import { adminOnboardingRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class OnboardingController {
  @ApiRoute(adminOnboardingRoute)
  checklist(): never {
    return routeStub(adminOnboardingRoute);
  }
}
