// Organisation export routes of the platform operators (Milestone 3 D.1, D.4): status of an organisation's exports and
// an export queued for its Tenant Admins. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is
// read); M3-02 replaces them.
import { Controller } from '@nestjs/common';
import {
  opsExportsCreateRoute,
  opsExportsListRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class OpsExportsController {
  @ApiRoute(opsExportsListRoute)
  opsExportsList(): never {
    return routeStub(opsExportsListRoute);
  }

  @ApiRoute(opsExportsCreateRoute)
  opsExportsCreate(): never {
    return routeStub(opsExportsCreateRoute);
  }
}
