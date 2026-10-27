// `PATCH /ms/{ms}/management-reviews/{id}` (Milestone 2 D.1): change the title, planned date, owner and linked
// systems of a planned or held management review (`management_review.manage`, `If-Match`).
import { Controller } from '@nestjs/common';
import { managementReviewsUpdateRoute, type CommandResult, type ManagementReviewPatch } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { ManagementReviewEditService } from './management-reviews.service';

@Controller()
export class ReviewEditController {
  constructor(private readonly reviews: ManagementReviewEditService) {}

  @ApiRoute(managementReviewsUpdateRoute)
  update(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string; id: string },
    @RouteInputParam('body') body: ManagementReviewPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.reviews.update(principal, params.ms, params.id, body, ifMatch);
  }
}
