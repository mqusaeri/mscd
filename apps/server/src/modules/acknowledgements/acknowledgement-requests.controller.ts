// Read confirmation requests of a system (Milestone 3 D.1, D.7): list, ask, read, remind, close and the register as
// CSV. The guard checks the permission of each route (D.1 table); the service applies the person-list split of D.7.
import { Controller, Res } from '@nestjs/common';
import {
  acknowledgementRequestsCloseRoute,
  acknowledgementRequestsCreateRoute,
  acknowledgementRequestsExportRoute,
  acknowledgementRequestsGetRoute,
  acknowledgementRequestsListRoute,
  acknowledgementRequestsRemindRoute,
  type AcknowledgementRequestClose,
  type AcknowledgementRequestCreate,
  type AcknowledgementRequestDetail,
  type AcknowledgementRequestItem,
  type CommandResult,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { FileResponder } from '../../common/file-response';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { AcknowledgementRequestsService } from './acknowledgement-requests.service';

type MsRecord = { ms: string; id: string };

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class AcknowledgementRequestsController {
  constructor(
    private readonly requests: AcknowledgementRequestsService,
    private readonly files: FileResponder,
  ) {}

  @ApiRoute(acknowledgementRequestsListRoute)
  acknowledgementRequestsList(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
  ): Promise<AcknowledgementRequestItem[]> {
    return this.requests.list(required(principal), params.ms);
  }

  @ApiRoute(acknowledgementRequestsCreateRoute)
  acknowledgementRequestsCreate(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: AcknowledgementRequestCreate,
  ): Promise<CommandResult> {
    return this.requests.create(required(principal), params.ms, body);
  }

  @ApiRoute(acknowledgementRequestsGetRoute)
  acknowledgementRequestsGet(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecord,
  ): Promise<AcknowledgementRequestDetail> {
    return this.requests.get(required(principal), params.ms, params.id);
  }

  @ApiRoute(acknowledgementRequestsRemindRoute)
  acknowledgementRequestsRemind(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecord,
  ): Promise<CommandResult> {
    return this.requests.remind(required(principal), params.ms, params.id);
  }

  @ApiRoute(acknowledgementRequestsCloseRoute)
  acknowledgementRequestsClose(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecord,
    @RouteInputParam('body') body: AcknowledgementRequestClose,
  ): Promise<CommandResult> {
    return this.requests.close(required(principal), params.ms, params.id, body ?? {});
  }

  /** The register of one request as formula-safe CSV, through the file responder (F.13, F.15). */
  @ApiRoute(acknowledgementRequestsExportRoute)
  async acknowledgementRequestsExport(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsRecord,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.requests.exportCsv(required(principal), params.ms, params.id);
    const body = Buffer.from(file.csv, 'utf8');
    await this.files.send(reply, {
      body,
      storedType: 'text/csv',
      fileName: file.fileName,
      size: body.length,
      audit: {
        action: 'file.downloaded',
        msId: file.msId,
        entityType: 'acknowledgement_request',
        entityId: params.id,
        entityCode: file.code,
        after: { format: 'csv', register: 'read_confirmations' },
      },
    });
  }
}
