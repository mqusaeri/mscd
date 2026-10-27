// `POST /me/mfa/recovery-codes` (Milestone 2 D.1): ten new recovery codes while keeping the authenticator, shown once.
import { Controller, Req, Res } from '@nestjs/common';
import { meRecoveryCodesRoute, type RecoveryCodesRequest, type RecoveryCodesResponse } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, RouteInputParam } from '../../common/api-route';
import { RecoveryCodesService } from './recovery-codes.service';

@Controller()
export class RecoveryCodesController {
  constructor(private readonly codes: RecoveryCodesService) {}

  @ApiRoute(meRecoveryCodesRoute)
  regenerate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RouteInputParam('body') body: RecoveryCodesRequest,
  ): Promise<RecoveryCodesResponse> {
    // The codes are shown once: never stored by a cache.
    reply.header('cache-control', 'no-store');
    return this.codes.regenerate(request, reply, body);
  }
}
