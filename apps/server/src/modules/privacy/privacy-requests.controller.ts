// Requests from one person, handled by the Tenant Admins (Milestone 3 D.1, D.6): register, read, start, refuse,
// correct, restrict, erase and close. The guard checks `privacy_request.manage` (Tenant Admins); the services apply the
// moves of J.8 and the rules of D.6.
import { Controller } from '@nestjs/common';
import {
  privacyRequestsCloseRoute,
  privacyRequestsCreateRoute,
  privacyRequestsEraseRoute,
  privacyRequestsGetRoute,
  privacyRequestsListRoute,
  privacyRequestsRectifyRoute,
  privacyRequestsRestrictRoute,
  privacyRequestsUpdateRoute,
  type CommandResult,
  type IdParams,
  type Page,
  type PrivacyClose,
  type PrivacyRectify,
  type PrivacyRequestCreate,
  type PrivacyRequestDetail,
  type PrivacyRequestItem,
  type PrivacyRequestListQuery,
  type PrivacyRequestPatch,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { PrivacyErasureService } from './privacy-erasure.service';
import { PrivacyRequestsService } from './privacy-requests.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class PrivacyRequestsController {
  constructor(
    private readonly requests: PrivacyRequestsService,
    private readonly erasure: PrivacyErasureService,
  ) {}

  @ApiRoute(privacyRequestsListRoute)
  privacyRequestsList(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('query') query: PrivacyRequestListQuery): Promise<Page<PrivacyRequestItem>> {
    return this.requests.list(required(principal), query);
  }

  @ApiRoute(privacyRequestsCreateRoute)
  privacyRequestsCreate(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: PrivacyRequestCreate): Promise<CommandResult> {
    return this.requests.create(required(principal), body);
  }

  @ApiRoute(privacyRequestsGetRoute)
  privacyRequestsGet(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: IdParams): Promise<PrivacyRequestDetail> {
    return this.requests.get(required(principal), params.id);
  }

  @ApiRoute(privacyRequestsUpdateRoute)
  privacyRequestsUpdate(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: PrivacyRequestPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.requests.update(required(principal), params.id, body, ifMatch);
  }

  @ApiRoute(privacyRequestsRectifyRoute)
  privacyRequestsRectify(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: PrivacyRectify,
  ): Promise<CommandResult> {
    return this.requests.rectify(required(principal), params.id, body);
  }

  @ApiRoute(privacyRequestsRestrictRoute)
  privacyRequestsRestrict(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.requests.restrict(required(principal), params.id);
  }

  @ApiRoute(privacyRequestsEraseRoute)
  privacyRequestsErase(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.erasure.erase(required(principal), params.id);
  }

  @ApiRoute(privacyRequestsCloseRoute)
  privacyRequestsClose(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: PrivacyClose,
  ): Promise<CommandResult> {
    return this.requests.close(required(principal), params.id, body);
  }
}
