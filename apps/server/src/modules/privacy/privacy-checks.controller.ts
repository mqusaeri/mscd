// The system checks of a request from one person (Milestone 3 D.1, D.6.4): the checks of a system, the records that
// name the person and the check marked done. The guard checks `privacy_request.assist` in the path system.
import { Controller } from '@nestjs/common';
import {
  privacyChecksDoneRoute,
  privacyChecksListRoute,
  privacyChecksMentionsRoute,
  type CommandResult,
  type MsParams,
  type MsRecordParams,
  type PrivacyCheckDone,
  type PrivacyCheckItem,
  type PrivacyMentions,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { PrivacyChecksService } from './privacy-checks.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class PrivacyChecksController {
  constructor(private readonly checks: PrivacyChecksService) {}

  @ApiRoute(privacyChecksListRoute)
  privacyChecksList(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: MsParams): Promise<PrivacyCheckItem[]> {
    return this.checks.list(required(principal), params.ms);
  }

  @ApiRoute(privacyChecksMentionsRoute)
  privacyChecksMentions(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: MsRecordParams): Promise<PrivacyMentions> {
    return this.checks.mentions(required(principal), params.ms, params.id);
  }

  @ApiRoute(privacyChecksDoneRoute)
  privacyChecksDone(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: PrivacyCheckDone,
  ): Promise<CommandResult> {
    return this.checks.done(required(principal), params.ms, params.id, body);
  }
}
