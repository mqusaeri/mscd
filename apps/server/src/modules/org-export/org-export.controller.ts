// Organisation export routes of the Tenant Admins (Milestone 3 D.1, D.4): list, request, read, decide, manifest and
// part download. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-02 replaces
// them.
import { Controller } from '@nestjs/common';
import {
  orgExportCreateRoute,
  orgExportDecideRoute,
  orgExportDownloadRoute,
  orgExportGetRoute,
  orgExportListRoute,
  orgExportManifestRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class OrgExportController {
  @ApiRoute(orgExportListRoute)
  orgExportList(): never {
    return routeStub(orgExportListRoute);
  }

  @ApiRoute(orgExportCreateRoute)
  orgExportCreate(): never {
    return routeStub(orgExportCreateRoute);
  }

  @ApiRoute(orgExportGetRoute)
  orgExportGet(): never {
    return routeStub(orgExportGetRoute);
  }

  @ApiRoute(orgExportDecideRoute)
  orgExportDecide(): never {
    return routeStub(orgExportDecideRoute);
  }

  @ApiRoute(orgExportManifestRoute)
  orgExportManifest(): never {
    return routeStub(orgExportManifestRoute);
  }

  @ApiRoute(orgExportDownloadRoute)
  orgExportDownload(): never {
    return routeStub(orgExportDownloadRoute);
  }
}
