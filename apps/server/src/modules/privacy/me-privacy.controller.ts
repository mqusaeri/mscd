// A person's own requests and profile corrections (Milestone 3 D.1, D.6): list and send requests, correct one's name
// and job title. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-04 replaces
// them.
import { Controller } from '@nestjs/common';
import {
  mePrivacyRequestsCreateRoute,
  mePrivacyRequestsListRoute,
  meProfileRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class MePrivacyController {
  @ApiRoute(mePrivacyRequestsListRoute)
  mePrivacyRequestsList(): never {
    return routeStub(mePrivacyRequestsListRoute);
  }

  @ApiRoute(mePrivacyRequestsCreateRoute)
  mePrivacyRequestsCreate(): never {
    return routeStub(mePrivacyRequestsCreateRoute);
  }

  @ApiRoute(meProfileRoute)
  meProfile(): never {
    return routeStub(meProfileRoute);
  }
}
