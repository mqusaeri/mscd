// Verified deletion routes of the platform operators (Milestone 3 D.1, D.5; M3-03): the deletion record, schedule or
// move, cancel, retry and the signed certificate. Every route needs a platform permission (`ops.read` or
// `ops.tenants.manage`), which only the `platform_operator` role grants (F.6); single tenancy answers 409
// `single_tenancy`.
import { Controller, Res } from '@nestjs/common';
import {
  opsDeletionCancelRoute,
  opsDeletionCertificateRoute,
  opsDeletionGetRoute,
  opsDeletionRetryRoute,
  opsDeletionScheduleRoute,
  type OpsReasonBody,
  type OrganizationDeletionResult,
  type OrganizationDeletionSchedule,
  type OrganizationDeletionView,
  type OrgParams,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../../common/api-route';
import { FILE_CONTENT_SECURITY_POLICY, contentDisposition } from '../../../common/file-response';
import { UnauthenticatedError } from '../../../common/problems';
import type { Principal } from '../../../common/tokens';
import { operatorOf } from '../organizations.service';
import { DeletionService } from './deletion.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class DeletionController {
  constructor(private readonly deletions: DeletionService) {}

  @ApiRoute(opsDeletionGetRoute)
  opsDeletionGet(@RouteInputParam('params') params: OrgParams): Promise<OrganizationDeletionView> {
    return this.deletions.get(params.org);
  }

  @ApiRoute(opsDeletionScheduleRoute)
  opsDeletionSchedule(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OrganizationDeletionSchedule,
  ): Promise<OrganizationDeletionResult> {
    return this.deletions.schedule(operatorOf(required(principal)), params.org, body);
  }

  @ApiRoute(opsDeletionCancelRoute)
  opsDeletionCancel(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OpsReasonBody,
  ): Promise<OrganizationDeletionResult> {
    return this.deletions.cancel(operatorOf(required(principal)), params.org, body.reason);
  }

  @ApiRoute(opsDeletionRetryRoute)
  opsDeletionRetry(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OpsReasonBody,
  ): Promise<OrganizationDeletionResult> {
    return this.deletions.retry(operatorOf(required(principal)), params.org, body.reason);
  }

  /** The signed certificate of a completed deletion as a JSON attachment (sandbox policy of file responses, F.13). */
  @ApiRoute(opsDeletionCertificateRoute)
  async opsDeletionCertificate(@RouteInputParam('params') params: OrgParams, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.deletions.certificate(params.org);
    const body = Buffer.from(file.text, 'utf8');
    reply.headers({
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': contentDisposition(file.fileName),
      'content-length': String(body.length),
      'content-security-policy': FILE_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    await reply.status(200).send(body);
  }
}
