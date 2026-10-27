// Certification cycles and the certificate record of a system (Milestone 2 D.1, D.4, J.8). Stubs of M2-02, answering
// 501 `not-implemented` after the guard; M2-05 replaces them and registers its services in certification.module.ts.
import { Controller } from '@nestjs/common';
import { msCertificationRoute, msCyclesCreateRoute, msCyclesListRoute, msCyclesTransitionRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class CertificationController {
  @ApiRoute(msCyclesListRoute)
  list(): never {
    return routeStub(msCyclesListRoute);
  }

  @ApiRoute(msCyclesCreateRoute)
  create(): never {
    return routeStub(msCyclesCreateRoute);
  }

  @ApiRoute(msCertificationRoute)
  certify(): never {
    return routeStub(msCertificationRoute);
  }

  @ApiRoute(msCyclesTransitionRoute)
  transition(): never {
    return routeStub(msCyclesTransitionRoute);
  }
}
