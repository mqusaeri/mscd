// Email domains of an organisation, verified by a DNS TXT record (Milestone 2 D.1, K.6 M2-S11). Stubs of M2-02,
// answering 501 `not-implemented` after the guard; M2-S11 replaces them and registers its services in
// domains.module.ts.
import { Controller } from '@nestjs/common';
import { opsDomainsAddRoute, opsDomainsListRoute, opsDomainsRemoveRoute, opsDomainsVerifyRoute } from '@mscd/shared';
import { ApiRoute } from '../../../common/api-route';
import { routeStub } from '../../../common/problems';

@Controller()
export class DomainsController {
  @ApiRoute(opsDomainsListRoute)
  list(): never {
    return routeStub(opsDomainsListRoute);
  }

  @ApiRoute(opsDomainsAddRoute)
  add(): never {
    return routeStub(opsDomainsAddRoute);
  }

  @ApiRoute(opsDomainsVerifyRoute)
  verify(): never {
    return routeStub(opsDomainsVerifyRoute);
  }

  @ApiRoute(opsDomainsRemoveRoute)
  remove(): never {
    return routeStub(opsDomainsRemoveRoute);
  }
}
