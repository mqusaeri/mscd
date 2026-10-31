// Periodic access review of the organisation (Milestone 3 D.1, D.9): settings, reviews, decisions on organisation
// items, applying them, completion, cancel and the report. Stubs of M3-01, answering 501 `not-implemented` after the
// guard (no body is read); M3-07 replaces them.
import { Controller } from '@nestjs/common';
import {
  accessReviewsApplyRoute,
  accessReviewsCancelRoute,
  accessReviewsCompleteRoute,
  accessReviewsCreateRoute,
  accessReviewsDecideRoute,
  accessReviewsGetRoute,
  accessReviewsListRoute,
  accessReviewsReportRoute,
  accessReviewsSettingsGetRoute,
  accessReviewsSettingsPutRoute,
} from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class AccessReviewsController {
  @ApiRoute(accessReviewsSettingsGetRoute)
  accessReviewsSettingsGet(): never {
    return routeStub(accessReviewsSettingsGetRoute);
  }

  @ApiRoute(accessReviewsSettingsPutRoute)
  accessReviewsSettingsPut(): never {
    return routeStub(accessReviewsSettingsPutRoute);
  }

  @ApiRoute(accessReviewsListRoute)
  accessReviewsList(): never {
    return routeStub(accessReviewsListRoute);
  }

  @ApiRoute(accessReviewsCreateRoute)
  accessReviewsCreate(): never {
    return routeStub(accessReviewsCreateRoute);
  }

  @ApiRoute(accessReviewsGetRoute)
  accessReviewsGet(): never {
    return routeStub(accessReviewsGetRoute);
  }

  @ApiRoute(accessReviewsDecideRoute)
  accessReviewsDecide(): never {
    return routeStub(accessReviewsDecideRoute);
  }

  @ApiRoute(accessReviewsApplyRoute)
  accessReviewsApply(): never {
    return routeStub(accessReviewsApplyRoute);
  }

  @ApiRoute(accessReviewsCompleteRoute)
  accessReviewsComplete(): never {
    return routeStub(accessReviewsCompleteRoute);
  }

  @ApiRoute(accessReviewsCancelRoute)
  accessReviewsCancel(): never {
    return routeStub(accessReviewsCancelRoute);
  }

  @ApiRoute(accessReviewsReportRoute)
  accessReviewsReport(): never {
    return routeStub(accessReviewsReportRoute);
  }
}
