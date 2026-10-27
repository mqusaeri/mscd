// `GET` and `PUT /ms/{ms}/freshness-thresholds` (Milestone 2 D.1): freshness limits per evidence frequency of a
// system. Stubs of M2-02, answering 501 `not-implemented` after the guard; M2-07 replaces them and registers its
// services in targets.module.ts.
import { Controller } from '@nestjs/common';
import { freshnessThresholdsGetRoute, freshnessThresholdsPutRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class FreshnessThresholdsController {
  @ApiRoute(freshnessThresholdsGetRoute)
  list(): never {
    return routeStub(freshnessThresholdsGetRoute);
  }

  @ApiRoute(freshnessThresholdsPutRoute)
  set(): never {
    return routeStub(freshnessThresholdsPutRoute);
  }
}
