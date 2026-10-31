// A person's own requests and profile corrections (Milestone 3 D.1, D.6.6): list and send requests, correct one's name
// and job title. The routes need an active session only; the service acts on the caller's own account (J.2).
import { Controller } from '@nestjs/common';
import {
  mePrivacyRequestsCreateRoute,
  mePrivacyRequestsListRoute,
  meProfileRoute,
  type CommandResult,
  type MyPrivacyRequestCreate,
  type MyPrivacyRequestItem,
  type MyProfilePatch,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { MePrivacyService } from './me-privacy.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class MePrivacyController {
  constructor(private readonly mine: MePrivacyService) {}

  @ApiRoute(mePrivacyRequestsListRoute)
  mePrivacyRequestsList(@CurrentPrincipal() principal: Principal | null): Promise<MyPrivacyRequestItem[]> {
    return this.mine.list(required(principal));
  }

  @ApiRoute(mePrivacyRequestsCreateRoute)
  mePrivacyRequestsCreate(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: MyPrivacyRequestCreate): Promise<CommandResult> {
    return this.mine.create(required(principal), body);
  }

  @ApiRoute(meProfileRoute)
  async meProfile(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: MyProfilePatch): Promise<void> {
    await this.mine.profile(required(principal), body);
  }
}
