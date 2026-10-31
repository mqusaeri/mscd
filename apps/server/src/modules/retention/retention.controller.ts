// Retention and disposal review of a system (Milestone 3 D.1, D.8): rules, reviews, approval, the disposal register and
// holds. Stubs of M3-01, answering 501 `not-implemented` after the guard (no body is read); M3-06 replaces them.
import { Controller } from '@nestjs/common';
import {
  retentionHoldsCreateRoute,
  retentionHoldsListRoute,
  retentionHoldsReleaseRoute,
  retentionRegisterRoute,
  retentionReviewsApproveRoute,
  retentionReviewsDecideRoute,
  retentionReviewsFileRemovedRoute,
  retentionReviewsListRoute,
  retentionReviewsRejectRoute,
  retentionRulesListRoute,
  retentionRulesPutRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class RetentionController {
  @ApiRoute(retentionRulesListRoute)
  retentionRulesList(): never {
    return routeStub(retentionRulesListRoute);
  }

  @ApiRoute(retentionRulesPutRoute)
  retentionRulesPut(): never {
    return routeStub(retentionRulesPutRoute);
  }

  @ApiRoute(retentionReviewsListRoute)
  retentionReviewsList(): never {
    return routeStub(retentionReviewsListRoute);
  }

  @ApiRoute(retentionReviewsDecideRoute)
  retentionReviewsDecide(): never {
    return routeStub(retentionReviewsDecideRoute);
  }

  @ApiRoute(retentionReviewsApproveRoute)
  retentionReviewsApprove(): never {
    return routeStub(retentionReviewsApproveRoute);
  }

  @ApiRoute(retentionReviewsRejectRoute)
  retentionReviewsReject(): never {
    return routeStub(retentionReviewsRejectRoute);
  }

  @ApiRoute(retentionReviewsFileRemovedRoute)
  retentionReviewsFileRemoved(): never {
    return routeStub(retentionReviewsFileRemovedRoute);
  }

  @ApiRoute(retentionRegisterRoute)
  retentionRegister(): never {
    return routeStub(retentionRegisterRoute);
  }

  @ApiRoute(retentionHoldsListRoute)
  retentionHoldsList(): never {
    return routeStub(retentionHoldsListRoute);
  }

  @ApiRoute(retentionHoldsCreateRoute)
  retentionHoldsCreate(): never {
    return routeStub(retentionHoldsCreateRoute);
  }

  @ApiRoute(retentionHoldsReleaseRoute)
  retentionHoldsRelease(): never {
    return routeStub(retentionHoldsReleaseRoute);
  }
}
