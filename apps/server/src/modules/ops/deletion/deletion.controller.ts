// Verified deletion routes of the platform operators (Milestone 3 D.1, D.5): the deletion record, schedule or move,
// cancel, retry and the signed certificate. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is
// read); M3-03 replaces them.
import { Controller } from '@nestjs/common';
import {
  opsDeletionCancelRoute,
  opsDeletionCertificateRoute,
  opsDeletionGetRoute,
  opsDeletionRetryRoute,
  opsDeletionScheduleRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../../common/api-route';
import { routeStub } from '../../../common/problems';

@Controller()
export class DeletionController {
  @ApiRoute(opsDeletionGetRoute)
  opsDeletionGet(): never {
    return routeStub(opsDeletionGetRoute);
  }

  @ApiRoute(opsDeletionScheduleRoute)
  opsDeletionSchedule(): never {
    return routeStub(opsDeletionScheduleRoute);
  }

  @ApiRoute(opsDeletionCancelRoute)
  opsDeletionCancel(): never {
    return routeStub(opsDeletionCancelRoute);
  }

  @ApiRoute(opsDeletionRetryRoute)
  opsDeletionRetry(): never {
    return routeStub(opsDeletionRetryRoute);
  }

  @ApiRoute(opsDeletionCertificateRoute)
  opsDeletionCertificate(): never {
    return routeStub(opsDeletionCertificateRoute);
  }
}
