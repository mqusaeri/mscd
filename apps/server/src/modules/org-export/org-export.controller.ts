// Organisation export routes of the Tenant Admins (Milestone 3 D.1, D.4): list, request, read, decide, manifest and
// part download (`org.export.manage`). Routes whose id starts with `exports.` stay usable while the organisation is
// `offboarding` (session resolver, `offboardingAllows`).
import { Controller, Res } from '@nestjs/common';
import {
  orgExportCreateRoute,
  orgExportDecideRoute,
  orgExportDownloadRoute,
  orgExportGetRoute,
  orgExportListRoute,
  orgExportManifestRoute,
  type IdParams,
  type OrganizationExportCreate,
  type OrganizationExportCreated,
  type OrganizationExportDecided,
  type OrganizationExportDecision,
  type OrganizationExportDetail,
  type OrganizationExportItem,
  type OrganizationExportPartParams,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { OrgExportService } from './org-export.service';

@Controller()
export class OrgExportController {
  constructor(private readonly exports: OrgExportService) {}

  @ApiRoute(orgExportListRoute)
  orgExportList(@CurrentPrincipal() principal: Principal): Promise<OrganizationExportItem[]> {
    return this.exports.list(principal);
  }

  @ApiRoute(orgExportCreateRoute)
  orgExportCreate(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: OrganizationExportCreate): Promise<OrganizationExportCreated> {
    return this.exports.create(principal, body);
  }

  @ApiRoute(orgExportGetRoute)
  orgExportGet(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<OrganizationExportDetail> {
    return this.exports.get(principal, params.id);
  }

  @ApiRoute(orgExportDecideRoute)
  orgExportDecide(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: OrganizationExportDecision,
  ): Promise<OrganizationExportDecided> {
    return this.exports.decide(principal, params.id, body);
  }

  @ApiRoute(orgExportManifestRoute)
  async orgExportManifest(@Res() reply: FastifyReply, @CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<void> {
    await this.exports.manifest(reply, principal, params.id);
  }

  @ApiRoute(orgExportDownloadRoute)
  async orgExportDownload(
    @Res() reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: OrganizationExportPartParams,
  ): Promise<void> {
    await this.exports.download(reply, principal, params.id, Number(params.part));
  }
}
