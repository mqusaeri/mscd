// `GET /ms/{ms}/internal-audit/programme` (Milestone 2 D.1, M2-05): clauses 4 to 10 and the applicable controls of a
// certification cycle with the internal audits that covered them.
import { Controller } from '@nestjs/common';
import { internalAuditProgrammeRoute, type InternalAuditProgramme, type InternalAuditProgrammeQuery, type MsParams } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { InternalAuditService } from './internal-audit.service';

@Controller()
export class InternalAuditController {
  constructor(private readonly internalAudit: InternalAuditService) {}

  @ApiRoute(internalAuditProgrammeRoute)
  programme(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('query') query: InternalAuditProgrammeQuery,
  ): Promise<InternalAuditProgramme> {
    return this.internalAudit.programme(principal, params.ms, query);
  }
}
