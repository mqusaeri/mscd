// Email domains of an organisation, verified by a DNS TXT record (Milestone 2 D.1, K.6, M2-S11). Platform routes of
// the operator: the list needs `ops.read`, the changes `ops.tenants.manage` (F.6). Multi tenancy only; single tenancy
// answers 409 `single_tenancy` (DomainsService).
import { Controller } from '@nestjs/common';
import {
  opsDomainsAddRoute,
  opsDomainsListRoute,
  opsDomainsRemoveRoute,
  opsDomainsVerifyRoute,
  type OrgDomain,
  type OrgDomainAdd,
  type OrgDomainAdded,
  type OrgDomainCheck,
  type OrgDomainParams,
  type OrgParams,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../../common/api-route';
import { UnauthenticatedError } from '../../../common/problems';
import type { Principal } from '../../../common/tokens';
import { operatorOf } from '../organizations.service';
import { DomainsService } from './domains.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @ApiRoute(opsDomainsListRoute)
  list(@RouteInputParam('params') params: OrgParams): Promise<OrgDomain[]> {
    return this.domains.list(params.org);
  }

  @ApiRoute(opsDomainsAddRoute)
  add(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OrgDomainAdd,
  ): Promise<OrgDomainAdded> {
    return this.domains.add(operatorOf(required(principal)), params.org, body.domain);
  }

  @ApiRoute(opsDomainsVerifyRoute)
  verify(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: OrgDomainParams): Promise<OrgDomainCheck> {
    return this.domains.verifyNow(operatorOf(required(principal)), params.org, params.domain);
  }

  @ApiRoute(opsDomainsRemoveRoute)
  async remove(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: OrgDomainParams): Promise<void> {
    await this.domains.remove(operatorOf(required(principal)), params.org, params.domain);
  }
}
