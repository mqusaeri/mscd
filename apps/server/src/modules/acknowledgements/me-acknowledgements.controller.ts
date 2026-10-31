// A person's own read confirmations (Milestone 3 D.1, D.7): the list, opening the version and the confirmation. Stubs
// of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-05 replaces them.
import { Controller } from '@nestjs/common';
import {
  meAcknowledgementsConfirmRoute,
  meAcknowledgementsOpenRoute,
  meAcknowledgementsRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class MeAcknowledgementsController {
  @ApiRoute(meAcknowledgementsRoute)
  meAcknowledgements(): never {
    return routeStub(meAcknowledgementsRoute);
  }

  @ApiRoute(meAcknowledgementsOpenRoute)
  meAcknowledgementsOpen(): never {
    return routeStub(meAcknowledgementsOpenRoute);
  }

  @ApiRoute(meAcknowledgementsConfirmRoute)
  meAcknowledgementsConfirm(): never {
    return routeStub(meAcknowledgementsConfirmRoute);
  }
}
