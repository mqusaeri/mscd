// Periodic access review of the organisation (Milestone 3 D.1, D.9, M3-07): settings with `If-Match`, reviews,
// decisions on organisation items, applying decided revocations, completion, cancel and the report. The guard checks
// `access_review.manage` (Tenant Admins), and `user.manage` for applying (route table); the services apply the rules.
import { Controller, Inject, Req, Res } from '@nestjs/common';
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
  type AccessReviewApply,
  type AccessReviewCancel,
  type AccessReviewDecide,
  type AccessReviewDetail,
  type AccessReviewItemParams,
  type AccessReviewSettings,
  type AccessReviewSettingsPut,
  type AccessReviewSummary,
  type CommandResult,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import { fileResponseHeaders } from '../../common/file-response';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { AccessReviewApplyService } from './access-review-apply.service';
import { AccessReviewsService } from './access-reviews.service';

@Controller()
export class AccessReviewsController {
  constructor(
    private readonly reviews: AccessReviewsService,
    private readonly applier: AccessReviewApplyService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  @ApiRoute(accessReviewsSettingsGetRoute)
  async accessReviewsSettingsGet(@Res({ passthrough: true }) reply: FastifyReply, @CurrentPrincipal() principal: Principal): Promise<AccessReviewSettings> {
    const settings = await this.reviews.settings(principal);
    reply.header('etag', settings.etag);
    return settings;
  }

  @ApiRoute(accessReviewsSettingsPutRoute)
  async accessReviewsSettingsPut(
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('body') body: AccessReviewSettingsPut,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<AccessReviewSettings> {
    const settings = await this.reviews.putSettings(principal, body, ifMatch);
    reply.header('etag', settings.etag);
    return settings;
  }

  @ApiRoute(accessReviewsListRoute)
  accessReviewsList(@CurrentPrincipal() principal: Principal): Promise<AccessReviewSummary[]> {
    return this.reviews.list(principal);
  }

  @ApiRoute(accessReviewsCreateRoute)
  accessReviewsCreate(@CurrentPrincipal() principal: Principal): Promise<CommandResult> {
    return this.reviews.create(principal);
  }

  @ApiRoute(accessReviewsGetRoute)
  accessReviewsGet(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { id: string }): Promise<AccessReviewDetail> {
    return this.reviews.get(principal, params.id);
  }

  @ApiRoute(accessReviewsDecideRoute)
  accessReviewsDecide(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: AccessReviewItemParams,
    @RouteInputParam('body') body: AccessReviewDecide,
  ): Promise<CommandResult> {
    return this.reviews.decide(principal, params.id, params.itemId, body);
  }

  @ApiRoute(accessReviewsApplyRoute)
  accessReviewsApply(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: AccessReviewItemParams,
    @RouteInputParam('body') body: AccessReviewApply,
  ): Promise<CommandResult> {
    return this.applier.apply(request, reply, principal, { kind: 'org' }, params.id, params.itemId, body);
  }

  @ApiRoute(accessReviewsCompleteRoute)
  accessReviewsComplete(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { id: string }): Promise<CommandResult> {
    return this.reviews.complete(principal, params.id);
  }

  @ApiRoute(accessReviewsCancelRoute)
  accessReviewsCancel(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: AccessReviewCancel,
  ): Promise<CommandResult> {
    return this.reviews.cancel(principal, params.id, body);
  }

  /** The review as a formula-safe CSV attachment (F.13, F.15), audited `file.downloaded` like the other register downloads. */
  @ApiRoute(accessReviewsReportRoute)
  async accessReviewsReport(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { id: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { csv, fileName, rows, reviewNo } = await this.reviews.report(principal, params.id);
    const body = Buffer.from(csv, 'utf8');
    await this.audit.recordDetached({
      action: 'file.downloaded',
      entityType: 'access_review',
      entityId: params.id,
      entityCode: reviewNo,
      after: { format: 'csv', rows, fileName },
    });
    reply.headers(fileResponseHeaders({ storedType: 'text/csv', fileName, size: body.byteLength }));
    reply.status(200);
    return body;
  }
}
