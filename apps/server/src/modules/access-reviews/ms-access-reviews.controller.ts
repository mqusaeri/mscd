// The system part of a periodic access review (Milestone 3 D.1, D.9): the parts, their items, decisions, revoking a
// guest auditor grant and the sign-off. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is
// read); M3-07 replaces them.
import { Controller } from '@nestjs/common';
import {
  accessReviewsMsApplyRoute,
  accessReviewsMsDecideRoute,
  accessReviewsMsGetRoute,
  accessReviewsMsListRoute,
  accessReviewsMsSignOffRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class MsAccessReviewsController {
  @ApiRoute(accessReviewsMsListRoute)
  accessReviewsMsList(): never {
    return routeStub(accessReviewsMsListRoute);
  }

  @ApiRoute(accessReviewsMsGetRoute)
  accessReviewsMsGet(): never {
    return routeStub(accessReviewsMsGetRoute);
  }

  @ApiRoute(accessReviewsMsDecideRoute)
  accessReviewsMsDecide(): never {
    return routeStub(accessReviewsMsDecideRoute);
  }

  @ApiRoute(accessReviewsMsApplyRoute)
  accessReviewsMsApply(): never {
    return routeStub(accessReviewsMsApplyRoute);
  }

  @ApiRoute(accessReviewsMsSignOffRoute)
  accessReviewsMsSignOff(): never {
    return routeStub(accessReviewsMsSignOffRoute);
  }
}
