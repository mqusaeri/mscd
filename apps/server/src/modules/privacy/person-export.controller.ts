// The export of one person's data (Milestone 3 D.1, D.6.3): for an access request (`privacy_request.manage`) and for
// the person themselves (an active session). Both answer 202 with the task id of `export.build`.
import { Controller } from '@nestjs/common';
import { meDataExportRoute, personExportCreateRoute, type CommandResult, type IdParams } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { PersonExportService } from './person-export.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class PersonExportController {
  constructor(private readonly exports: PersonExportService) {}

  @ApiRoute(personExportCreateRoute)
  personExportCreate(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: IdParams): Promise<CommandResult> {
    return this.exports.forRequest(required(principal), params.id);
  }

  @ApiRoute(meDataExportRoute)
  meDataExport(@CurrentPrincipal() principal: Principal | null): Promise<CommandResult> {
    return this.exports.forMe(required(principal));
  }
}
