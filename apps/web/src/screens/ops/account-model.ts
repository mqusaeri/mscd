// The accounts and platform operators of the operator console (MILESTONE-2 M2-19): the view types both adapters give
// (api.ts from `ops.accounts.*` and `ops.operators.*`, sample.ts from the sample service), the actions an account can
// take with the reason each asks for, and the text helpers of the Accounts tab.
import type { ApiError } from '../../data/api/ApiClient';
import type { Tone } from '../ui';
import type { HostContext, TextPair } from '../types';
import { ACCOUNT_TEXT } from './account-text';

export const ACCOUNT_KINDS = ['person', 'guest', 'system'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_STATUSES = ['active', 'invited', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type MembershipStatus = AccountStatus;
export type AdminRole = 'tenant_admin' | 'storage_admin';

/** Rows per page of the account list. */
export const ACCOUNT_PAGE_SIZE = 25;
/** A reason has 3 to 500 characters (the server's `OpsActionReason`). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface Membership {
  org: string;
  orgName: string;
  status: MembershipStatus;
  adminRoles: AdminRole[];
}

export interface AccountItem {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  kind: AccountKind;
  status: AccountStatus;
  mfaEnrolled: boolean;
  locked: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  platformOperator: boolean;
  memberships: Membership[];
  /** The ETag of the account row (`If-Match` of the status change). */
  etag: string;
}

export interface AccountSession {
  startedAt: string;
  lastSeenAt: string;
  method: string;
  state: string;
  network: string | null;
  browser: string | null;
  org: string | null;
}

export interface AccountAuditEntry {
  at: string;
  action: string;
  actorKind: 'user' | 'system' | 'guest' | 'operator';
  actor: { handle: string; displayName: string } | null;
  org: string | null;
  reason: string | null;
}

export interface AccountDetail extends AccountItem {
  sessions: AccountSession[];
  audit: AccountAuditEntry[];
}

export interface AccountQuery {
  page: number;
  pageSize: number;
  q?: string;
  org?: string;
  status?: AccountStatus;
  kind?: AccountKind;
}

export interface AccountPage {
  items: AccountItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** The answer of an action: the server's message, the sessions it ended and a one-time link when one is shown. */
export interface ActionDone {
  status: AccountStatus;
  sessionsRevoked: number;
  emailed: boolean;
  /** Only where mail is not required and the email did not go out (never on SaaS). */
  link: string | null;
  message: TextPair | null;
}

export interface OperatorItem {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  mfaEnrolled: boolean;
  passwordSet: boolean;
  lastSignInAt: string | null;
  grantedAt: string;
  grantedBy: { handle: string; displayName: string } | null;
  self: boolean;
}

export interface OperatorAdded {
  id: string;
  email: string;
  newAccount: boolean;
  emailed: boolean;
  link: string | null;
  message: TextPair | null;
}

export interface OperatorRemoved {
  sessionsRevoked: number;
  operatorsLeft: number;
  message: TextPair | null;
}

/** The actions of the account drawer. */
export type AccountAction = 'reset-mfa' | 'password' | 'sessions' | 'disable' | 'enable' | 'resend';

/** The action as the operator chooses it: `resend` names the organisation of the pending membership. */
export interface ActionTarget {
  action: AccountAction;
  org?: Membership;
}

export const ACTION_LABEL: Readonly<Record<AccountAction, TextPair>> = {
  'reset-mfa': ACCOUNT_TEXT.actResetMfa,
  password: ACCOUNT_TEXT.actPassword,
  sessions: ACCOUNT_TEXT.actSessions,
  disable: ACCOUNT_TEXT.actDisable,
  enable: ACCOUNT_TEXT.actEnable,
  resend: ACCOUNT_TEXT.actResend,
};

/** What each action does, listed before the operator confirms it. */
export const ACTION_EFFECTS: Readonly<Record<AccountAction, readonly TextPair[]>> = {
  'reset-mfa': [ACCOUNT_TEXT.effResetMfa1, ACCOUNT_TEXT.effResetMfa2, ACCOUNT_TEXT.effEmail],
  password: [ACCOUNT_TEXT.effPassword1, ACCOUNT_TEXT.effPassword2],
  sessions: [ACCOUNT_TEXT.effSessions1, ACCOUNT_TEXT.effSessions2],
  disable: [ACCOUNT_TEXT.effDisable1, ACCOUNT_TEXT.effDisable2],
  enable: [ACCOUNT_TEXT.effEnable1, ACCOUNT_TEXT.effEnable2],
  resend: [ACCOUNT_TEXT.effResend1, ACCOUNT_TEXT.effResend2],
};

export const ACTION_TONE: Readonly<Record<AccountAction, 'danger' | 'primary' | 'default'>> = {
  'reset-mfa': 'danger', password: 'default', sessions: 'danger', disable: 'danger', enable: 'primary', resend: 'default',
};

export const STATUS_LABEL: Readonly<Record<AccountStatus, TextPair>> = {
  active: ACCOUNT_TEXT.statusActive, invited: ACCOUNT_TEXT.statusInvited, disabled: ACCOUNT_TEXT.statusDisabled,
};
export const STATUS_TONE: Readonly<Record<AccountStatus, Tone>> = { active: 'ok', invited: 'info', disabled: 'mute' };
export const KIND_LABEL: Readonly<Record<AccountKind, TextPair>> = { person: ACCOUNT_TEXT.kindPerson, guest: ACCOUNT_TEXT.kindGuest, system: ACCOUNT_TEXT.kindSystem };
export const ROLE_LABEL: Readonly<Record<AdminRole, TextPair>> = { tenant_admin: ACCOUNT_TEXT.roleTenantAdmin, storage_admin: ACCOUNT_TEXT.roleStorageAdmin };
export const METHOD_LABEL: Readonly<Record<string, TextPair>> = {
  local: ACCOUNT_TEXT.methodLocal, oidc: ACCOUNT_TEXT.methodOidc, saml: ACCOUNT_TEXT.methodSaml, guest: ACCOUNT_TEXT.methodGuest,
  demo: ACCOUNT_TEXT.methodDemo, test: ACCOUNT_TEXT.methodTest,
};

/** Plain words for the audit actions an account sees most; others show their id. */
export const AUDIT_LABEL: Readonly<Record<string, TextPair>> = {
  'auth.login': ACCOUNT_TEXT.auditLogin,
  'auth.login_failed': ACCOUNT_TEXT.auditLoginFailed,
  'auth.logout': ACCOUNT_TEXT.auditLogout,
  'auth.mfa_enrolled': ACCOUNT_TEXT.auditMfaEnrolled,
  'auth.mfa_reset': ACCOUNT_TEXT.auditMfaReset,
  'auth.mfa_locked': ACCOUNT_TEXT.auditMfaLocked,
  'auth.password_reset': ACCOUNT_TEXT.auditPasswordReset,
  'auth.password_changed': ACCOUNT_TEXT.auditPasswordChanged,
  'auth.session_revoked': ACCOUNT_TEXT.auditSessionRevoked,
  'user.created': ACCOUNT_TEXT.auditUserCreated,
  'user.invited': ACCOUNT_TEXT.auditUserInvited,
  'user.updated': ACCOUNT_TEXT.auditUserUpdated,
  'membership.updated': ACCOUNT_TEXT.auditMembershipUpdated,
  'ops.operator_created': ACCOUNT_TEXT.auditOperatorCreated,
  'ops.operator_revoked': ACCOUNT_TEXT.auditOperatorRevoked,
};

/**
 * The actions the drawer offers for an account: none for the system account. On the operator's own account, only the
 * password link: a reset of the second factor would end the operator's own sessions (the person replaces their
 * authenticator on My account), and ending the sessions or disabling the account is for another operator. An invited
 * account is neither disabled nor enabled: it becomes active when the person accepts the invitation.
 */
export function actionsFor(account: AccountItem, selfId: string | null): AccountAction[] {
  if (account.kind === 'system') return [];
  const self = account.id === selfId;
  const out: AccountAction[] = [];
  if (!self && account.mfaEnrolled) out.push('reset-mfa');
  if (account.kind === 'person' && account.status === 'active') out.push('password');
  if (!self) out.push('sessions');
  if (!self && account.status === 'active') out.push('disable');
  if (!self && account.status === 'disabled') out.push('enable');
  return out;
}

/** The memberships whose invitation the operator may send again (invited, on an account that is not disabled). */
export function resendable(account: AccountItem): Membership[] {
  if (account.kind === 'system' || account.status === 'disabled') return [];
  return account.memberships.filter((m) => m.status === 'invited');
}

/** The reason check of every action form: 3 to 500 characters. */
export function reasonError(reason: string): TextPair | null {
  const n = reason.trim().length;
  if (n < REASON_MIN) return ACCOUNT_TEXT.reasonShort;
  if (n > REASON_MAX) return ACCOUNT_TEXT.reasonLong;
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OperatorForm {
  email: string;
  name: string;
  reason: string;
}

export const EMPTY_OPERATOR_FORM: OperatorForm = { email: '', name: '', reason: '' };

/** Field errors of the Add operator form before it is sent. */
export function operatorErrors(form: OperatorForm): Partial<Record<keyof OperatorForm, TextPair>> {
  const out: Partial<Record<keyof OperatorForm, TextPair>> = {};
  if (!EMAIL.test(form.email.trim()) || form.email.trim().length > 254) out.email = ACCOUNT_TEXT.emailInvalid;
  if (!form.name.trim()) out.name = ACCOUNT_TEXT.nameRequired;
  const reason = reasonError(form.reason);
  if (reason) out.reason = reason;
  return out;
}

/**
 * The text of a refusal of the account routes. The server gives English and Indonesian for its own refusals
 * (`own_account`, `last_operator`, `mail_required` and the others); a stale `If-Match` (412) has the console's text.
 */
export function accountRefusal(error: ApiError): TextPair {
  if (error.status === 412) return ACCOUNT_TEXT.changedMeanwhile;
  return error.message;
}

/** "Rina Kusuma (rina.kusuma@nusantaradigital.co.id)": how a confirmation names the account. */
export function accountName(account: Pick<AccountItem, 'displayName' | 'email'>): string {
  return account.displayName && account.displayName !== account.email ? `${account.displayName} (${account.email})` : account.email;
}

/** The admin roles of a membership in words, or the plain member text. */
export function rolesText(ctx: Pick<HostContext, 'li'>, roles: readonly AdminRole[]): string {
  return roles.length ? roles.map((r) => ctx.li(ROLE_LABEL[r])).join(', ') : ctx.li(ACCOUNT_TEXT.roleMember);
}
