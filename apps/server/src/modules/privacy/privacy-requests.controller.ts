// Requests from one person, handled by the Tenant Admins (Milestone 3 D.1, D.6): register, read, start, refuse,
// correct, restrict, erase and close. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is
// read); M3-04 replaces them.
import { Controller } from '@nestjs/common';
import {
  privacyRequestsCloseRoute,
  privacyRequestsCreateRoute,
  privacyRequestsEraseRoute,
  privacyRequestsGetRoute,
  privacyRequestsListRoute,
  privacyRequestsRectifyRoute,
  privacyRequestsRestrictRoute,
  privacyRequestsUpdateRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class PrivacyRequestsController {
  @ApiRoute(privacyRequestsListRoute)
  privacyRequestsList(): never {
    return routeStub(privacyRequestsListRoute);
  }

  @ApiRoute(privacyRequestsCreateRoute)
  privacyRequestsCreate(): never {
    return routeStub(privacyRequestsCreateRoute);
  }

  @ApiRoute(privacyRequestsGetRoute)
  privacyRequestsGet(): never {
    return routeStub(privacyRequestsGetRoute);
  }

  @ApiRoute(privacyRequestsUpdateRoute)
  privacyRequestsUpdate(): never {
    return routeStub(privacyRequestsUpdateRoute);
  }

  @ApiRoute(privacyRequestsRectifyRoute)
  privacyRequestsRectify(): never {
    return routeStub(privacyRequestsRectifyRoute);
  }

  @ApiRoute(privacyRequestsRestrictRoute)
  privacyRequestsRestrict(): never {
    return routeStub(privacyRequestsRestrictRoute);
  }

  @ApiRoute(privacyRequestsEraseRoute)
  privacyRequestsErase(): never {
    return routeStub(privacyRequestsEraseRoute);
  }

  @ApiRoute(privacyRequestsCloseRoute)
  privacyRequestsClose(): never {
    return routeStub(privacyRequestsCloseRoute);
  }
}
