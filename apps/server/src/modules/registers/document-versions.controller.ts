// `GET /ms/{ms}/documents/{id}/versions` (Milestone 2 D.1): the version history of a document. Stub of M2-02, answering
// 501 `not-implemented` after the guard; M2-07 replaces it and registers its services in holdings.module.ts.
import { Controller } from '@nestjs/common';
import { documentsVersionsListRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class DocumentVersionsController {
  @ApiRoute(documentsVersionsListRoute)
  versions(): never {
    return routeStub(documentsVersionsListRoute);
  }
}
