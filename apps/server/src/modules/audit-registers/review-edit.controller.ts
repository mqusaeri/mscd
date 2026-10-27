// `PATCH /ms/{ms}/management-reviews/{id}` (Milestone 2 D.1): change a planned or held management review. Stub of
// M2-02, answering 501 `not-implemented` after the guard; M2-07 replaces it and registers its services in
// review-edit.module.ts.
import { Controller } from '@nestjs/common';
import { managementReviewsUpdateRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class ReviewEditController {
  @ApiRoute(managementReviewsUpdateRoute)
  update(): never {
    return routeStub(managementReviewsUpdateRoute);
  }
}
