// `GET /ms/{ms}/documents/{id}/versions` (Milestone 2 D.1): the version history of a document, newest first, with the
// scope policy of the document.
import { Controller } from '@nestjs/common';
import { documentsVersionsListRoute, type DocumentVersionItem } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { DocumentVersionsService } from './documents.service';

@Controller()
export class DocumentVersionsController {
  constructor(private readonly versionsService: DocumentVersionsService) {}

  @ApiRoute(documentsVersionsListRoute)
  versions(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: { ms: string; id: string }): Promise<DocumentVersionItem[]> {
    return this.versionsService.list(principal, params.ms, params.id);
  }
}
