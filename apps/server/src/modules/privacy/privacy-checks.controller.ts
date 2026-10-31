// The system checks of a request from one person (Milestone 3 D.1, D.6.4): the checks of a system, the records that
// name the person and the check marked done. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body
// is read); M3-04 replaces them.
import { Controller } from '@nestjs/common';
import {
  privacyChecksDoneRoute,
  privacyChecksListRoute,
  privacyChecksMentionsRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class PrivacyChecksController {
  @ApiRoute(privacyChecksListRoute)
  privacyChecksList(): never {
    return routeStub(privacyChecksListRoute);
  }

  @ApiRoute(privacyChecksMentionsRoute)
  privacyChecksMentions(): never {
    return routeStub(privacyChecksMentionsRoute);
  }

  @ApiRoute(privacyChecksDoneRoute)
  privacyChecksDone(): never {
    return routeStub(privacyChecksDoneRoute);
  }
}
