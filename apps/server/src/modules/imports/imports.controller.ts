// Bulk import routes (Milestone 2 D.1, D2-13): template, upload with dry run, state and commit. Stubs of M2-02,
// answering 501 `not-implemented` after the guard (the upload body is not read); M2-08 replaces them.
import { Controller } from '@nestjs/common';
import { importsCommitRoute, importsCreateRoute, importsGetRoute, importsTemplatesRoute } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { routeStub } from '../../common/problems';

@Controller()
export class ImportsController {
  @ApiRoute(importsTemplatesRoute)
  template(): never {
    return routeStub(importsTemplatesRoute);
  }

  @ApiRoute(importsCreateRoute)
  upload(): never {
    return routeStub(importsCreateRoute);
  }

  @ApiRoute(importsGetRoute)
  get(): never {
    return routeStub(importsGetRoute);
  }

  @ApiRoute(importsCommitRoute)
  commit(): never {
    return routeStub(importsCommitRoute);
  }
}
