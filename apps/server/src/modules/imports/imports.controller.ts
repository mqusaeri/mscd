// Bulk import routes (Milestone 2 D.1, D2-13, M2-08): template, upload with dry run, state and commit
// (imports.service.ts). The upload is a multipart body the handler reads itself, after the guard checked the
// permission of the kind in the path.
import { Controller, Req, Res } from '@nestjs/common';
import {
  importsCommitRoute, importsCreateRoute, importsGetRoute, importsTemplatesRoute, type CommandResult, type ImportKindParams, type ImportRun,
  type ImportTemplateQuery, type MsRecordParams,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { ImportsService, templateLanguage } from './imports.service';

@Controller()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @ApiRoute(importsTemplatesRoute)
  async template(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: ImportKindParams,
    @RouteInputParam('query') query: ImportTemplateQuery,
  ): Promise<void> {
    await this.imports.template(reply, principal, params.ms, params.kind, templateLanguage(request, query.lang));
  }

  @ApiRoute(importsCreateRoute)
  upload(
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: ImportKindParams,
  ): Promise<ImportRun> {
    return this.imports.upload(request, principal, authz, params.ms, params.kind);
  }

  @ApiRoute(importsGetRoute)
  get(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<ImportRun> {
    return this.imports.get(principal, params.ms, params.id);
  }

  @ApiRoute(importsCommitRoute)
  commit(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: MsRecordParams): Promise<CommandResult> {
    return this.imports.commit(principal, params.ms, params.id);
  }
}
