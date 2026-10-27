// Open items a person holds and their handover (Milestone 2 D.1, H.13): the items of one system for MS Managers and
// Programme Owners (`record.assign`), counts without titles for the Tenant Admin (`user.manage`).
import { Controller } from '@nestjs/common';
import {
  adminUsersHoldingsRoute, recordsHoldingsReassignRoute, recordsHoldingsRoute, type CommandResult, type HoldingParams, type Holdings,
  type HoldingsReassign, type UserHoldings,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { HoldingsService } from './holdings.service';

@Controller()
export class HoldingsController {
  constructor(private readonly holdingsService: HoldingsService) {}

  @ApiRoute(recordsHoldingsRoute)
  holdings(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: HoldingParams): Promise<Holdings> {
    return this.holdingsService.holdings(principal, params.ms, params.handle);
  }

  @ApiRoute(recordsHoldingsReassignRoute)
  reassign(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: HoldingParams,
    @RouteInputParam('body') body: HoldingsReassign,
  ): Promise<CommandResult> {
    return this.holdingsService.reassign(principal, params.ms, params.handle, body);
  }

  @ApiRoute(adminUsersHoldingsRoute)
  userHoldings(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { id: string }): Promise<UserHoldings> {
    return this.holdingsService.userHoldings(principal, params.id);
  }
}
