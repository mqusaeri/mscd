// Retention and disposal review of a system (Milestone 3 D.1, D.8, M3-06): rules, reviews and their decision, approval
// and rejection, "File removed", the disposal register (JSON page or CSV attachment) and legal holds. The guard checks
// `retention.manage` or `retention.approve` in the system of the path (route table); the service applies the rules.
import { Controller, Inject, Res } from '@nestjs/common';
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
  type CommandResult,
  type MsRecordParams,
  type RetentionDecide,
  type RetentionHoldCreate,
  type RetentionHoldItem,
  type RetentionHoldRelease,
  type RetentionNote,
  type RetentionRegisterItem,
  type RetentionRegisterQuery,
  type RetentionReviewItem,
  type RetentionReviewListQuery,
  type RetentionRuleItem,
  type RetentionRuleParams,
  type RetentionRulePut,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { Clock } from '../../common/clock';
import { fileResponseHeaders } from '../../common/file-response';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { orgOf } from '../registers/command-support';
import { RetentionService, type Page } from './retention.service';

@Controller()
export class RetentionController {
  constructor(
    private readonly retention: RetentionService,
    private readonly clock: Clock,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  @ApiRoute(retentionRulesListRoute)
  retentionRulesList(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string }): Promise<RetentionRuleItem[]> {
    return this.retention.rules(principal, params.ms);
  }

  @ApiRoute(retentionRulesPutRoute)
  retentionRulesPut(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: RetentionRuleParams,
    @RouteInputParam('body') body: RetentionRulePut,
  ): Promise<CommandResult> {
    return this.retention.putRule(principal, params.ms, params.recordClass, body);
  }

  @ApiRoute(retentionReviewsListRoute)
  retentionReviewsList(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: RetentionReviewListQuery,
  ): Promise<Page<RetentionReviewItem>> {
    return this.retention.reviews(principal, params.ms, query);
  }

  @ApiRoute(retentionReviewsDecideRoute)
  retentionReviewsDecide(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: RetentionDecide,
  ): Promise<CommandResult> {
    return this.retention.decide(principal, params.ms, body);
  }

  @ApiRoute(retentionReviewsApproveRoute)
  retentionReviewsApprove(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<CommandResult> {
    return this.retention.approve(principal, params.ms, params.id);
  }

  @ApiRoute(retentionReviewsRejectRoute)
  retentionReviewsReject(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: RetentionNote,
  ): Promise<CommandResult> {
    return this.retention.reject(principal, params.ms, params.id, body.note);
  }

  @ApiRoute(retentionReviewsFileRemovedRoute)
  retentionReviewsFileRemoved(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<CommandResult> {
    return this.retention.fileRemoved(principal, params.ms, params.id);
  }

  /**
   * The disposal register: a page of decided reviews, or with `format=csv` the whole register as a formula-safe CSV
   * attachment (F.13, F.15), audited `file.downloaded` like the other register downloads.
   */
  @ApiRoute(retentionRegisterRoute)
  async retentionRegister(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('query') query: RetentionRegisterQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Page<RetentionRegisterItem> | Buffer> {
    if (query.format !== 'csv') return this.retention.register(principal, params.ms, query.page, query.pageSize);
    const org = orgOf(principal);
    const today = this.clock.todayIn(org.timeZone);
    const fileName = `disposal-register-${org.slug}-${params.ms}-${today}.csv`;
    const { csv, msId, rows } = await this.retention.registerCsv(principal, params.ms);
    const body = Buffer.from(csv, 'utf8');
    await this.audit.recordDetached({
      action: 'file.downloaded',
      msId,
      entityType: 'retention_register',
      entityCode: fileName.slice(0, 80),
      after: { ms: params.ms, format: 'csv', rows },
    });
    reply.headers(fileResponseHeaders({ storedType: 'text/csv', fileName, size: body.byteLength }));
    reply.status(200);
    return body;
  }

  @ApiRoute(retentionHoldsListRoute)
  retentionHoldsList(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string }): Promise<RetentionHoldItem[]> {
    return this.retention.holds(principal, params.ms);
  }

  @ApiRoute(retentionHoldsCreateRoute)
  retentionHoldsCreate(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: RetentionHoldCreate,
  ): Promise<CommandResult> {
    return this.retention.createHold(principal, params.ms, body);
  }

  @ApiRoute(retentionHoldsReleaseRoute)
  retentionHoldsRelease(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: RetentionHoldRelease,
  ): Promise<CommandResult> {
    return this.retention.releaseHold(principal, params.ms, params.id, body.reason);
  }
}
