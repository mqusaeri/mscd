// Per-organisation entitlements and plan presets of the SaaS track (Milestone 2 D.1, K.6, M2-S10): the operator
// routes `ops.entitlements.get` and `ops.entitlements.set`, which send the entitlement's ETag, and `ops.plans.list`.
// The permission checks (`ops.read`, `ops.entitlements.manage`, platform scope) are the guard's; the rules are in
// entitlement.service.ts.
import { Controller, Res } from '@nestjs/common';
import {
  opsEntitlementsGetRoute,
  opsEntitlementsSetRoute,
  opsPlansListRoute,
  type Entitlement,
  type EntitlementSet,
  type EntitlementSetResult,
  type OrgParams,
  type PlanPreset,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { EntitlementService } from './entitlement.service';

@Controller()
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementService) {}

  @ApiRoute(opsEntitlementsGetRoute)
  async get(
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
  ): Promise<Entitlement> {
    const read = await this.entitlements.get(principal, params.org);
    reply.header('etag', read.etag);
    return read.entitlement;
  }

  @ApiRoute(opsEntitlementsSetRoute)
  async set(
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: EntitlementSet,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<EntitlementSetResult> {
    if (!principal) throw new UnauthenticatedError();
    const written = await this.entitlements.set(principal, params.org, body, ifMatch);
    reply.header('etag', written.etag);
    return written.result;
  }

  @ApiRoute(opsPlansListRoute)
  plans(): PlanPreset[] {
    return this.entitlements.plans();
  }
}
