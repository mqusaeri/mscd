// Per-organisation entitlements and plan presets of the SaaS track (Milestone 2 D.1, K.6). Stubs of M2-02, answering
// 501 `not-implemented` after the guard; M2-S10 replaces them and registers its services in entitlements.module.ts.
import { Controller } from '@nestjs/common';
import { opsEntitlementsGetRoute, opsEntitlementsSetRoute, opsPlansListRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class EntitlementsController {
  @ApiRoute(opsEntitlementsGetRoute)
  get(): never {
    return routeStub(opsEntitlementsGetRoute);
  }

  @ApiRoute(opsEntitlementsSetRoute)
  set(): never {
    return routeStub(opsEntitlementsSetRoute);
  }

  @ApiRoute(opsPlansListRoute)
  plans(): never {
    return routeStub(opsPlansListRoute);
  }
}
