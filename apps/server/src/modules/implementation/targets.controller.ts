// `GET /ms/{ms}/applicability/targets` (Milestone 2 D.1): the catalogue items and requirements of the active edition,
// with whether the system has an entry for each, for the Add control form and the import resolver.
import { Controller } from '@nestjs/common';
import { applicabilityTargetsRoute, type ApplicabilityTargetItem, type ApplicabilityTargetsQuery } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { ApplicabilityTargetsService } from './applicability.service';

@Controller()
export class TargetsController {
  constructor(private readonly targetsService: ApplicabilityTargetsService) {}

  @ApiRoute(applicabilityTargetsRoute)
  targets(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: ApplicabilityTargetsQuery,
  ): Promise<ApplicabilityTargetItem[]> {
    return this.targetsService.list(principal, params.ms, query ?? {});
  }
}
