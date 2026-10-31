// The export of one person's data (Milestone 3 D.1, D.6.3): for an access request and for the person themselves. Stubs
// of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-04 replaces them.
import { Controller } from '@nestjs/common';
import {
  meDataExportRoute,
  personExportCreateRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class PersonExportController {
  @ApiRoute(personExportCreateRoute)
  personExportCreate(): never {
    return routeStub(personExportCreateRoute);
  }

  @ApiRoute(meDataExportRoute)
  meDataExport(): never {
    return routeStub(meDataExportRoute);
  }
}
