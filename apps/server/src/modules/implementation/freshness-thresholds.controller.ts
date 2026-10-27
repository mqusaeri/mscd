// `GET` and `PUT /ms/{ms}/freshness-thresholds` (Milestone 2 D.1): freshness limits per evidence frequency of a
// system, in force (`set` for the system or `default`) and set or reset by the MS Manager (`applicability.manage`).
import { Controller } from '@nestjs/common';
import {
  freshnessThresholdsGetRoute, freshnessThresholdsPutRoute, type CommandResult, type FreshnessThresholdItem, type FreshnessThresholdParams,
  type FreshnessThresholdSet,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { FreshnessThresholdsService } from './freshness-thresholds.service';

@Controller()
export class FreshnessThresholdsController {
  constructor(private readonly thresholds: FreshnessThresholdsService) {}

  @ApiRoute(freshnessThresholdsGetRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string }): Promise<FreshnessThresholdItem[]> {
    return this.thresholds.list(principal, params.ms);
  }

  @ApiRoute(freshnessThresholdsPutRoute)
  set(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: FreshnessThresholdParams,
    @RouteInputParam('body') body: FreshnessThresholdSet,
  ): Promise<CommandResult> {
    return this.thresholds.set(principal, params.ms, params.frequencyCode, body);
  }
}
