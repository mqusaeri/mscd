// The system part of a periodic access review (Milestone 3 D.1, D.9, M3-07): the parts, their items, decisions,
// revoking a guest auditor grant and the sign-off. The guard checks `access_review.decide` (Management System Managers
// and Programme Owners of the system), and `auditor_access.grant` for applying (route table).
import { Controller, Req, Res } from '@nestjs/common';
import {
  accessReviewsMsApplyRoute,
  accessReviewsMsDecideRoute,
  accessReviewsMsGetRoute,
  accessReviewsMsListRoute,
  accessReviewsMsSignOffRoute,
  type AccessReviewApply,
  type AccessReviewDecide,
  type AccessReviewPartDetail,
  type AccessReviewPartSummary,
  type AccessReviewSignOff,
  type CommandResult,
  type MsAccessReviewItemParams,
  type MsRecordParams,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { AccessReviewApplyService } from './access-review-apply.service';
import { AccessReviewsService } from './access-reviews.service';

@Controller()
export class MsAccessReviewsController {
  constructor(
    private readonly reviews: AccessReviewsService,
    private readonly applier: AccessReviewApplyService,
  ) {}

  @ApiRoute(accessReviewsMsListRoute)
  accessReviewsMsList(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string }): Promise<AccessReviewPartSummary[]> {
    return this.reviews.msList(principal, params.ms);
  }

  @ApiRoute(accessReviewsMsGetRoute)
  accessReviewsMsGet(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<AccessReviewPartDetail> {
    return this.reviews.msGet(principal, params.ms, params.id);
  }

  @ApiRoute(accessReviewsMsDecideRoute)
  accessReviewsMsDecide(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsAccessReviewItemParams,
    @RouteInputParam('body') body: AccessReviewDecide,
  ): Promise<CommandResult> {
    return this.reviews.msDecide(principal, params.ms, params.id, params.itemId, body);
  }

  @ApiRoute(accessReviewsMsApplyRoute)
  accessReviewsMsApply(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsAccessReviewItemParams,
    @RouteInputParam('body') body: AccessReviewApply,
  ): Promise<CommandResult> {
    return this.applier.apply(request, reply, principal, { kind: 'ms', ms: params.ms }, params.id, params.itemId, body);
  }

  @ApiRoute(accessReviewsMsSignOffRoute)
  accessReviewsMsSignOff(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: AccessReviewSignOff,
  ): Promise<CommandResult> {
    return this.reviews.signOff(principal, params.ms, params.id, body);
  }
}
