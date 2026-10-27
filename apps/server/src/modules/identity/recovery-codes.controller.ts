// `POST /me/mfa/recovery-codes` (Milestone 2 D.1): ten new recovery codes while keeping the authenticator. Stub of
// M2-02, answering 501 `not-implemented` after the guard; M2-06 replaces it and registers its services in
// recovery-codes.module.ts.
import { Controller } from '@nestjs/common';
import { meRecoveryCodesRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class RecoveryCodesController {
  @ApiRoute(meRecoveryCodesRoute)
  regenerate(): never {
    return routeStub(meRecoveryCodesRoute);
  }
}
