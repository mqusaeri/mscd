// Operations routes of the platform operator (D.3 "Operations", WP-34). Every route needs a platform permission
// (`ops.read`, `ops.jobs.run`, `ops.tenants.manage` or `ops.users.manage`), which only the `platform_operator` role
// grants (F.6). Milestone 2 (D.1, M2-06): the organisation list and creation and the second-factor reset by email.
// Milestone 2 (D.1, K.6, M2-S09): the organisation detail, its status changes along the machine of J.8 and its status
// history.
import { Controller, Inject, Res } from '@nestjs/common';
import {
  opsDiagnosticsRoute,
  opsHealthRoute,
  opsJobRunRoute,
  opsOrganizationsCreateRoute,
  opsOrganizationsEventsRoute,
  opsOrganizationsGetRoute,
  opsOrganizationsListRoute,
  opsOrganizationsStatusRoute,
  opsQueuesRoute,
  opsUsersResetMfaRoute,
  type JobRunParams,
  type JobRunRequest,
  type JobRunResponse,
  type OpsHealth,
  type OpsOrganizationCreate,
  type OpsOrganizationCreateResult,
  type OpsOrganizationDetail,
  type OpsOrganizationItem,
  type OpsOrganizationListQuery,
  type OpsResetMfaRequest,
  type OrganizationEventsQuery,
  type OrganizationStatusChange,
  type OrganizationStatusChangeResult,
  type OrganizationStatusEventItem,
  type OrgParams,
  type Page,
  type QueueStats,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { FILE_CONTENT_SECURITY_POLICY, contentDisposition } from '../../common/file-response';
import { UnauthenticatedError } from '../../common/problems';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { DiagnosticsService } from './diagnostics.service';
import { OperatorAccountsService } from './operator-accounts.service';
import { OpsService } from './ops.service';
import { OrganizationStatusService } from './organization-status.service';
import { OpsOrganizationsService, operatorOf } from './organizations.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly diagnostics: DiagnosticsService,
    private readonly organizations: OpsOrganizationsService,
    private readonly accounts: OperatorAccountsService,
    private readonly statuses: OrganizationStatusService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  @ApiRoute(opsHealthRoute)
  health(): Promise<OpsHealth> {
    return this.ops.health();
  }

  @ApiRoute(opsQueuesRoute)
  queues(): Promise<QueueStats[]> {
    return this.ops.queues();
  }

  @ApiRoute(opsJobRunRoute)
  run(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: JobRunParams,
    @RouteInputParam('body') body: JobRunRequest,
  ): Promise<JobRunResponse> {
    return this.ops.runJob(required(principal), params.name, body);
  }

  /**
   * The archive is audited (`ops.diagnostics_exported`, platform chain) before the bytes are sent, and sent as an
   * attachment with the sandbox policy of file responses (F.13).
   */
  @ApiRoute(opsDiagnosticsRoute)
  async export(@CurrentPrincipal() principal: Principal | null, @Res() reply: FastifyReply): Promise<void> {
    const operator = required(principal);
    const archive = await this.diagnostics.build();
    await this.audit.recordDetached({
      action: 'ops.diagnostics_exported',
      actor: { userId: operator.user.id, kind: 'operator' },
      organizationId: null,
      entityType: 'diagnostics',
      entityCode: archive.fileName.slice(0, 80),
      after: { fileName: archive.fileName, sha256: archive.sha256, bytes: archive.data.length, files: archive.files.length, logLines: archive.logLines },
    });
    reply.headers({
      'content-type': 'application/gzip',
      'content-disposition': contentDisposition(archive.fileName),
      'content-length': String(archive.data.length),
      'content-security-policy': FILE_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    await reply.status(200).send(archive.data);
  }

  // Milestone 2 D.1 (M2-06): the organisation list and creation and the factor reset.
  @ApiRoute(opsOrganizationsListRoute)
  listOrganizations(@RouteInputParam('query') query: OpsOrganizationListQuery): Promise<Page<OpsOrganizationItem>> {
    return this.organizations.list(query);
  }

  @ApiRoute(opsOrganizationsCreateRoute)
  createOrganization(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: OpsOrganizationCreate): Promise<OpsOrganizationCreateResult> {
    return this.organizations.create(operatorOf(required(principal)), body);
  }

  @ApiRoute(opsUsersResetMfaRoute)
  resetMfa(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: OpsResetMfaRequest): Promise<void> {
    return this.accounts.resetMfa(required(principal), body);
  }

  // Milestone 2 D.1, K.6 (M2-S09): the organisation detail, its status changes and its status history.

  @ApiRoute(opsOrganizationsGetRoute)
  organization(@RouteInputParam('params') params: OrgParams): Promise<OpsOrganizationDetail> {
    return this.organizations.detail(params.org);
  }

  @ApiRoute(opsOrganizationsStatusRoute)
  async organizationStatus(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OrganizationStatusChange,
  ): Promise<OrganizationStatusChangeResult> {
    return (await this.statuses.change(operatorOf(required(principal)), params.org, body)).result;
  }

  @ApiRoute(opsOrganizationsEventsRoute)
  organizationEvents(@RouteInputParam('params') params: OrgParams, @RouteInputParam('query') query: OrganizationEventsQuery): Promise<Page<OrganizationStatusEventItem>> {
    return this.organizations.events(params.org, query);
  }
}
