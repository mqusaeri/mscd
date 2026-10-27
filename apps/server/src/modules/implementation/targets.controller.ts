// `GET /ms/{ms}/applicability/targets` (Milestone 2 D.1): the catalogue items and requirements of the active edition.
// Stub of M2-02, answering 501 `not-implemented` after the guard; M2-07 replaces it and registers its services in
// targets.module.ts.
import { Controller } from '@nestjs/common';
import { applicabilityTargetsRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class TargetsController {
  @ApiRoute(applicabilityTargetsRoute)
  targets(): never {
    return routeStub(applicabilityTargetsRoute);
  }
}
