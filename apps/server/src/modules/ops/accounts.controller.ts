// Routes of the accounts and platform operators of the service (Milestone 2 section L, M2-19). Reads need `ops.read`,
// actions `ops.users.manage`; both are platform permissions that only the `platform_operator` role holds (F.6). The
// services keep the rules: OpsAccountsService for the accounts, OperatorsService for the operator role.
import { Controller } from '@nestjs/common';
import {
  opsAccountsGetRoute,
  opsAccountsInvitationResendRoute,
  opsAccountsListRoute,
  opsAccountsPasswordResetRoute,
  opsAccountsResetMfaRoute,
  opsAccountsSessionsRevokeRoute,
  opsAccountsStatusRoute,
  opsOperatorsAddRoute,
  opsOperatorsListRoute,
  opsOperatorsRemoveRoute,
  type AccountInvitationParams,
  type AccountParams,
  type OpsAccountActionResult,
  type OpsAccountDetail,
  type OpsAccountItem,
  type OpsAccountListQuery,
  type OpsAccountStatusChange,
  type OpsOperatorAdd,
  type OpsOperatorAddResult,
  type OpsOperatorItem,
  type OpsOperatorRemoveResult,
  type OpsReasonBody,
  type Page,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { OpsAccountsService } from './accounts.service';
import { OperatorsService } from './operators.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class OpsAccountsController {
  constructor(
    private readonly accounts: OpsAccountsService,
    private readonly operators: OperatorsService,
  ) {}

  @ApiRoute(opsAccountsListRoute)
  list(@RouteInputParam('query') query: OpsAccountListQuery): Promise<Page<OpsAccountItem>> {
    return this.accounts.list(query);
  }

  @ApiRoute(opsAccountsGetRoute)
  get(@RouteInputParam('params') params: AccountParams): Promise<OpsAccountDetail> {
    return this.accounts.detail(params.id);
  }

  @ApiRoute(opsAccountsResetMfaRoute)
  resetMfa(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: AccountParams, @RouteInputParam('body') body: OpsReasonBody): Promise<OpsAccountActionResult> {
    return this.accounts.resetMfa(required(principal), params.id, body.reason);
  }

  @ApiRoute(opsAccountsPasswordResetRoute)
  passwordReset(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: AccountParams, @RouteInputParam('body') body: OpsReasonBody): Promise<OpsAccountActionResult> {
    return this.accounts.passwordReset(required(principal), params.id, body.reason);
  }

  @ApiRoute(opsAccountsInvitationResendRoute)
  resendInvitation(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: AccountInvitationParams,
    @RouteInputParam('body') body: OpsReasonBody,
  ): Promise<OpsAccountActionResult> {
    return this.accounts.resendInvitation(required(principal), params.id, params.org, body.reason);
  }

  @ApiRoute(opsAccountsSessionsRevokeRoute)
  revokeSessions(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: AccountParams, @RouteInputParam('body') body: OpsReasonBody): Promise<OpsAccountActionResult> {
    return this.accounts.revokeSessions(required(principal), params.id, body.reason);
  }

  @ApiRoute(opsAccountsStatusRoute)
  status(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: AccountParams,
    @RouteInputParam('body') body: OpsAccountStatusChange,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<OpsAccountActionResult> {
    return this.accounts.changeStatus(required(principal), params.id, body, ifMatch);
  }

  @ApiRoute(opsOperatorsListRoute)
  listOperators(@CurrentPrincipal() principal: Principal | null): Promise<OpsOperatorItem[]> {
    return this.operators.list(required(principal));
  }

  @ApiRoute(opsOperatorsAddRoute)
  addOperator(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: OpsOperatorAdd): Promise<OpsOperatorAddResult> {
    return this.operators.add(required(principal), body);
  }

  @ApiRoute(opsOperatorsRemoveRoute)
  removeOperator(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: AccountParams, @RouteInputParam('body') body: OpsReasonBody): Promise<OpsOperatorRemoveResult> {
    return this.operators.remove(required(principal), params.id, body.reason);
  }
}
