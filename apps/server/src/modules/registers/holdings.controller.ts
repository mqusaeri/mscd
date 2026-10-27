// Open items a person holds and their handover (Milestone 2 D.1, H.13): the items of one system for MS Managers and
// Programme Owners, counts without titles for the Tenant Admin. Stubs of M2-02, answering 501 `not-implemented`
// after the guard; M2-07 replaces them and registers its services in holdings.module.ts.
import { Controller } from '@nestjs/common';
import { adminUsersHoldingsRoute, recordsHoldingsReassignRoute, recordsHoldingsRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class HoldingsController {
  @ApiRoute(recordsHoldingsRoute)
  holdings(): never {
    return routeStub(recordsHoldingsRoute);
  }

  @ApiRoute(recordsHoldingsReassignRoute)
  reassign(): never {
    return routeStub(recordsHoldingsReassignRoute);
  }

  @ApiRoute(adminUsersHoldingsRoute)
  userHoldings(): never {
    return routeStub(adminUsersHoldingsRoute);
  }
}
