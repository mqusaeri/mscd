// The required documented information of an edition and the mapping of pack document codes to registered documents
// (Milestone 2 D.1). Stubs of M2-02, answering 501 `not-implemented` after the guard; M2-07 replaces them and
// registers its services in targets.module.ts.
import { Controller } from '@nestjs/common';
import { documentedInfoLinkRoute, documentedInfoListRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class DocumentedInfoController {
  @ApiRoute(documentedInfoListRoute)
  list(): never {
    return routeStub(documentedInfoListRoute);
  }

  @ApiRoute(documentedInfoLinkRoute)
  link(): never {
    return routeStub(documentedInfoLinkRoute);
  }
}
