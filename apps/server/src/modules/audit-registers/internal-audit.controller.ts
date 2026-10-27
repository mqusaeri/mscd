// `GET /ms/{ms}/internal-audit/programme` (Milestone 2 D.1): clauses 4 to 10 and the applicable controls of a cycle
// with the internal audits that covered them. Stub of M2-02, answering 501 `not-implemented` after the guard; M2-05
// replaces it and registers its services in internal-audit.module.ts.
import { Controller } from '@nestjs/common';
import { internalAuditProgrammeRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class InternalAuditController {
  @ApiRoute(internalAuditProgrammeRoute)
  programme(): never {
    return routeStub(internalAuditProgrammeRoute);
  }
}
