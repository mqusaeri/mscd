// Read confirmation requests of a system (Milestone 3 D.1, D.7): list, ask, read, remind, close and the register as
// CSV. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-05 replaces them.
import { Controller } from '@nestjs/common';
import {
  acknowledgementRequestsCloseRoute,
  acknowledgementRequestsCreateRoute,
  acknowledgementRequestsExportRoute,
  acknowledgementRequestsGetRoute,
  acknowledgementRequestsListRoute,
  acknowledgementRequestsRemindRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class AcknowledgementRequestsController {
  @ApiRoute(acknowledgementRequestsListRoute)
  acknowledgementRequestsList(): never {
    return routeStub(acknowledgementRequestsListRoute);
  }

  @ApiRoute(acknowledgementRequestsCreateRoute)
  acknowledgementRequestsCreate(): never {
    return routeStub(acknowledgementRequestsCreateRoute);
  }

  @ApiRoute(acknowledgementRequestsGetRoute)
  acknowledgementRequestsGet(): never {
    return routeStub(acknowledgementRequestsGetRoute);
  }

  @ApiRoute(acknowledgementRequestsRemindRoute)
  acknowledgementRequestsRemind(): never {
    return routeStub(acknowledgementRequestsRemindRoute);
  }

  @ApiRoute(acknowledgementRequestsCloseRoute)
  acknowledgementRequestsClose(): never {
    return routeStub(acknowledgementRequestsCloseRoute);
  }

  @ApiRoute(acknowledgementRequestsExportRoute)
  acknowledgementRequestsExport(): never {
    return routeStub(acknowledgementRequestsExportRoute);
  }
}
