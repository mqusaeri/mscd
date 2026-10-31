// Organisation export routes of the platform operators (Milestone 3 D.1, D.4): the status of an organisation's exports
// (`ops.read`) and an export queued for its Tenant Admins (`ops.tenants.manage`, audited `ops.export_requested`). The
// operator never reads the content and never downloads an export (M2 K.8). Multi tenancy only: single tenancy answers
// 409 `single_tenancy`.
import { Controller } from '@nestjs/common';
import {
  opsExportsCreateRoute,
  opsExportsListRoute,
  type OpsOrganizationExportItem,
  type OpsOrganizationExportQueued,
  type OpsReasonBody,
  type OrgParams,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { OrgExportService } from './org-export.service';

@Controller()
export class OpsExportsController {
  constructor(private readonly exports: OrgExportService) {}

  @ApiRoute(opsExportsListRoute)
  opsExportsList(@RouteInputParam('params') params: OrgParams): Promise<OpsOrganizationExportItem[]> {
    return this.exports.opsList(params.org);
  }

  @ApiRoute(opsExportsCreateRoute)
  opsExportsCreate(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: OrgParams,
    @RouteInputParam('body') body: OpsReasonBody,
  ): Promise<OpsOrganizationExportQueued> {
    return this.exports.opsCreate(principal, params.org, body.reason);
  }
}
