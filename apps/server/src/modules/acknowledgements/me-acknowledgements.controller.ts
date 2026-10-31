// A person's own read confirmations (Milestone 3 D.1, D.7): the list, opening the version and the confirmation. The
// routes need an active session only; the service acts on the caller's own rows (J.2).
import { Controller } from '@nestjs/common';
import {
  meAcknowledgementsConfirmRoute,
  meAcknowledgementsOpenRoute,
  meAcknowledgementsRoute,
  type CommandResult,
  type IdParams,
  type MyAcknowledgementItem,
  type ObjectOpenResponse,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { MeAcknowledgementsService } from './me-acknowledgements.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class MeAcknowledgementsController {
  constructor(private readonly mine: MeAcknowledgementsService) {}

  @ApiRoute(meAcknowledgementsRoute)
  meAcknowledgements(@CurrentPrincipal() principal: Principal | null): Promise<MyAcknowledgementItem[]> {
    return this.mine.list(required(principal));
  }

  @ApiRoute(meAcknowledgementsOpenRoute)
  meAcknowledgementsOpen(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
  ): Promise<ObjectOpenResponse> {
    return this.mine.open(required(principal), params.id);
  }

  @ApiRoute(meAcknowledgementsConfirmRoute)
  meAcknowledgementsConfirm(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: IdParams,
  ): Promise<CommandResult> {
    return this.mine.confirm(required(principal), params.id);
  }
}
