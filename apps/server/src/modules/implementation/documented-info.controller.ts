// The required documented information of an edition and the mapping of pack document codes to registered documents
// (Milestone 2 D.1): `documented-info.list` (ms.read) and `documented-info.link` (document.manage).
import { Controller } from '@nestjs/common';
import {
  documentedInfoLinkRoute, documentedInfoListRoute, type CommandResult, type DocumentedInfoItem, type DocumentedInfoLink, type DocumentedInfoParams,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { DocumentedInfoService } from './documented-info.service';

@Controller()
export class DocumentedInfoController {
  constructor(private readonly info: DocumentedInfoService) {}

  @ApiRoute(documentedInfoListRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string }): Promise<DocumentedInfoItem[]> {
    return this.info.list(principal, params.ms);
  }

  @ApiRoute(documentedInfoLinkRoute)
  link(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: DocumentedInfoParams,
    @RouteInputParam('body') body: DocumentedInfoLink,
  ): Promise<CommandResult> {
    return this.info.link(principal, params.ms, params.code, body);
  }
}
