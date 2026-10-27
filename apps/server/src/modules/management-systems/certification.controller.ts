// Certification cycles and the certificate record of a system (Milestone 2 D.1, D.4, J.8, M2-05): the cycles of a
// system, starting a cycle, recording the certificate, and the manual moves of a cycle.
import { Controller } from '@nestjs/common';
import {
  msCertificationRoute,
  msCyclesCreateRoute,
  msCyclesListRoute,
  msCyclesTransitionRoute,
  type CertificationCycleCreate,
  type CertificationCycleItem,
  type CertificationRecord,
  type CommandResult,
  type CycleTransitionRequest,
  type MsParams,
  type MsRecordParams,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { CertificationService } from './certification.service';

@Controller()
export class CertificationController {
  constructor(private readonly certification: CertificationService) {}

  @ApiRoute(msCyclesListRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsParams): Promise<CertificationCycleItem[]> {
    return this.certification.list(principal, params.ms);
  }

  @ApiRoute(msCyclesCreateRoute)
  create(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: CertificationCycleCreate,
  ): Promise<CommandResult> {
    return this.certification.create(principal, params.ms, body);
  }

  @ApiRoute(msCertificationRoute)
  certify(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsParams,
    @RouteInputParam('body') body: CertificationRecord,
  ): Promise<CommandResult> {
    return this.certification.certify(principal, params.ms, body);
  }

  @ApiRoute(msCyclesTransitionRoute)
  transition(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: CycleTransitionRequest,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.certification.transition(principal, params.ms, params.id, body, ifMatch);
  }
}
