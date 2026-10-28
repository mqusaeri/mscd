// The view model of the People and roles screen (MILESTONE-2 M2-10) and the interface both adapters implement (api.ts
// in API builds, sample.ts in the sample build, chosen by the build in adapter.ts). The helpers below decide who may do
// what (F.6 Tenant Admin limits, D2-12 four-eyes grants), check the forms and build the request bodies
// (`UserCreate`, `UserPatch`, `RoleGrant`, `UserIdentityRegistration` of D.2) and the roles and responsibilities CSV.
// The Pending approvals screen uses the same model for its role grants.
import type { BusinessRole, OrgRole, RoleGrant, UserCreate, UserPatch } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import { ADMIN_ROLE_LABELS, BUSINESS_ROLE_LABELS } from '../roles';
import type { HostContext, Lang, TextPair } from '../types';
import { TEXT } from './text';

/** What an adapter call answered: its data and message, or the api's refusal. */
export type Result<T> = { ok: true; data: T; message?: TextPair | null } | { ok: false; error: ApiError };

export type AdminRole = OrgRole;
export type BusinessRoleCode = BusinessRole;
export type MembershipState = 'active' | 'invited' | 'disabled';
export type GrantState = 'active' | 'pending_approval' | 'rejected';

export const ADMIN_ROLES: readonly AdminRole[] = ['tenant_admin', 'storage_admin'];
export const BUSINESS_ROLES: readonly BusinessRoleCode[] = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'external_auditor', 'compliance_investigator',
];

/** One role grant of a member (`UserRoleGrantView`). */
export interface GrantModel {
  grantId: string;
  /** Slug of the management system. */
  ms: string;
  role: BusinessRoleCode;
  isPrimary: boolean;
  approvalStatus: GrantState;
  validUntil: string | null;
}

/** A member of the organisation (`UserView`). */
export interface Member {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  kind: 'person' | 'system' | 'guest';
  accountStatus: MembershipState;
  membershipStatus: MembershipState;
  adminRoles: AdminRole[];
  roles: GrantModel[];
  mfaEnrolled: boolean;
  otherMemberships: boolean;
  lastLoginAt: string | null;
}

/** A management system the grant routes name: its uuid (`id`), slug, code and name. */
export interface SystemRef {
  id: string;
  slug: string;
  code: string;
  name: string;
  archived: boolean;
}

/** An identity provider of the organisation, for the pre-registration form. */
export interface ProviderRef {
  slug: string;
  name: string;
  kind: 'oidc' | 'saml';
  enabled: boolean;
}

/** What the screen needs of the organisation settings. */
export interface OrgFacts {
  tenancyMode: 'single' | 'multi' | null;
}

/** Who asked for and who decided on a grant, and when (from the audit trail metadata; unknown parts are null). */
export interface GrantHistory {
  requestedBy: PersonRef | null;
  requestedAt: string | null;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
}

export interface PersonRef {
  handle: string | null;
  name: string;
}

/**
 * The roles of the session user as `GET /me` gives them after the session was renewed (F.1): the administration roles,
 * and the business roles and UI role per management system.
 */
export interface SessionRoles {
  adminRoles: string[];
  rolesByMs: Record<string, readonly string[]>;
  uiRoleByMs: Record<string, string>;
}

/**
 * What follows a change: `none` (not a change of the session user's own roles), `reload` (the session was renewed and a
 * snapshot reload carries the change: permissions, systems and the sidebar come from `/ui/org`) or `restart` (the app
 * loads again, see `sessionRestart`).
 */
export type Renewal = 'none' | 'reload' | 'restart';

/** Open items of a member in one system (`admin.users.holdings`): counts per kind and the primary MS Manager. */
export interface HoldingsSystem {
  ms: string;
  name: string;
  primaryManager: { handle: string; displayName: string; email: string } | null;
  counts: Partial<Record<string, number>>;
  total: number;
}

/** The answer of a role grant: active at once, or waiting for a second Tenant Admin, with the server's message. */
export interface GrantOutcome {
  approvalStatus: 'active' | 'pending_approval';
  grantId: string;
}

export interface UsersAdapter {
  /** Every member of the organisation (all pages). */
  members(): Promise<Result<Member[]>>;
  systems(): Promise<Result<SystemRef[]>>;
  providers(): Promise<Result<ProviderRef[]>>;
  org(): Promise<Result<OrgFacts>>;
  invite(body: UserCreate, idempotencyKey: string): Promise<Result<null>>;
  update(id: string, patch: UserPatch): Promise<Result<Member>>;
  grant(system: SystemRef, body: RoleGrant, idempotencyKey: string): Promise<Result<GrantOutcome>>;
  approve(system: SystemRef, grantId: string): Promise<Result<null>>;
  reject(system: SystemRef, grantId: string): Promise<Result<null>>;
  revoke(system: SystemRef, grantId: string): Promise<Result<null>>;
  holdings(userId: string): Promise<Result<HoldingsSystem[]>>;
  registerIdentity(userId: string, body: { provider: string; subject: string }, idempotencyKey: string): Promise<Result<null>>;
  resetMfa(userId: string): Promise<Result<null>>;
  /** Request and decision of grants: of the ids given, or of every grant in the audit trail when `ids` is null. */
  history(ids: string[] | null): Promise<Result<Record<string, GrantHistory>>>;
  /**
   * The grant `grantId` of `member` as the server holds it now, or null when it is gone. The Revoke dialog reads it for
   * a grant the page lists as waiting: another Tenant Admin may have approved or rejected it since the page loaded.
   */
  currentGrant(member: Pick<Member, 'id' | 'handle' | 'email'>, grantId: string): Promise<Result<GrantModel | null>>;
  /**
   * `GET /me` after a change of the session user's own roles: the server gave the session a new id, so the CSRF token
   * changed too, and the client takes the new one from this answer (F.1). Null in the sample build (no session).
   */
  renewSession(): Promise<Result<SessionRoles | null>>;
}

// ---------------------------------------------------------------------------------------------------------------
// The session person and administrators
// ---------------------------------------------------------------------------------------------------------------

/** The session person: the signed-in user (api) or the sample persona's person (sample members use the handle as id). */
export function selfOf(ctx: HostContext): { id: string; handle: string } {
  if (ctx.me) return { id: ctx.me.user.id, handle: ctx.me.user.handle };
  return { id: ctx.person.handle, handle: ctx.person.handle };
}

export function isSelf(ctx: HostContext, member: Pick<Member, 'id' | 'handle'>): boolean {
  const self = selfOf(ctx);
  return member.id === self.id || (!ctx.me && member.handle === self.handle);
}

/** Active Tenant Admins with an active account (the people who can approve a grant, F.6). */
export function activeTenantAdmins(members: readonly Member[]): Member[] {
  return members.filter((m) => m.kind === 'person' && m.membershipStatus === 'active' && m.accountStatus === 'active' && m.adminRoles.includes('tenant_admin'));
}

/** The member of the session in the member list, or null. */
export function selfMember(ctx: HostContext, members: readonly Member[]): Member | null {
  return members.find((m) => isSelf(ctx, m)) ?? null;
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Whether saving `patch` changes the session user's own administration roles. The server then gives the session a new
 * id (F.1), and with it a new CSRF token.
 */
export function renewsOnEdit(ctx: HostContext, member: Member, patch: UserPatch): boolean {
  return patch.adminRoles !== undefined && isSelf(ctx, member) && !sameSet(patch.adminRoles, member.adminRoles);
}

/**
 * Whether a revocation of a grant of `member` may renew the session: any grant of the session user (F.1). The server
 * renews the session when the grant is active in the database, and the page may show an older state: another Tenant
 * Admin may have approved a grant the page still lists as waiting. So every revocation of your own grant reads
 * `GET /me`; for a grant that was still waiting, that read finds the same roles and costs one request.
 */
export function renewsOnRevoke(ctx: HostContext, member: Pick<Member, 'id' | 'handle'>): boolean {
  return isSelf(ctx, member);
}

/** Whether the Revoke dialog says that your session is renewed: your own grant, active as the dialog knows it. */
export function revokesOwnRole(ctx: HostContext, member: Pick<Member, 'id' | 'handle'>, grant: Pick<GrantModel, 'approvalStatus'>): boolean {
  return grant.approvalStatus === 'active' && isSelf(ctx, member);
}

/**
 * Whether the app must load again after the session user's own roles changed. A snapshot reload carries the
 * permissions, the systems and the host screens of the sidebar (`/ui/org`), but the shell keeps the `Me` it read when it
 * started: whether the session holds an administration role (the Administration entries, the landing without a
 * system), whether it is a Tenant Admin (decisions in Pending approvals), and the business roles and UI role in each
 * system it still holds (the views and the role label). When one of these changed, the app loads again. A system the
 * session no longer holds a role in leaves the snapshot's system list and needs no new load.
 */
export function sessionRestart(before: Partial<Pick<SessionRoles, 'adminRoles' | 'rolesByMs' | 'uiRoleByMs'>> | null, after: SessionRoles): boolean {
  if (!before) return false;
  const admin = before.adminRoles ?? [];
  const [roles, ui] = [before.rolesByMs ?? {}, before.uiRoleByMs ?? {}];
  if ((admin.length > 0) !== (after.adminRoles.length > 0)) return true;
  if (admin.includes('tenant_admin') !== after.adminRoles.includes('tenant_admin')) return true;
  return Object.keys(after.rolesByMs).some((ms) => !sameSet(roles[ms], after.rolesByMs[ms]) || ui[ms] !== after.uiRoleByMs[ms]);
}

/**
 * Whether a grant to `grantee` waits for a second Tenant Admin (F.6, D2-12): a grant to yourself, or to a member who
 * holds an administration role in an active membership.
 */
export function needsApproval(ctx: HostContext, grantee: Member): boolean {
  return isSelf(ctx, grantee) || (grantee.membershipStatus === 'active' && grantee.adminRoles.length > 0);
}

/** The Tenant Admins who can approve a grant: active ones who neither asked for it nor receive it. */
export function approversOf(members: readonly Member[], requester: { id?: string | null; handle?: string | null } | null, granteeId: string): Member[] {
  return activeTenantAdmins(members).filter((m) => m.id !== granteeId && !(requester && (m.id === requester.id || (requester.handle && m.handle === requester.handle))));
}

/**
 * Why the session may not disable a member, or null: never yourself, never an invited membership (it becomes active
 * only when the person accepts, and the server refuses any other change of its status), never the last active
 * Tenant Admin.
 */
export function disableBlock(ctx: HostContext, member: Member, members: readonly Member[]): TextPair | null {
  if (isSelf(ctx, member)) return TEXT.disableSelf;
  if (member.membershipStatus === 'invited') return TEXT.disableInvited;
  if (member.membershipStatus === 'active' && member.accountStatus === 'active' && member.adminRoles.includes('tenant_admin')) {
    if (activeTenantAdmins(members).filter((m) => m.id !== member.id).length === 0) return TEXT.disableLastAdmin;
  }
  return null;
}

/** Why the session may not grant a role to a member, or null. */
export function grantBlock(member: Member): TextPair | null {
  if (member.kind === 'guest') return TEXT.grantGuest;
  if (member.membershipStatus === 'invited') return TEXT.grantInvited;
  if (member.membershipStatus === 'disabled') return TEXT.grantDisabled;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------

export const MEMBERSHIP_LABELS: Readonly<Record<MembershipState, { label: TextPair; tone: 'ok' | 'info' | 'mute' }>> = {
  active: { label: TEXT.statusActive, tone: 'ok' },
  invited: { label: TEXT.statusInvited, tone: 'info' },
  disabled: { label: TEXT.statusDisabled, tone: 'mute' },
};

export const roleLabel = (role: BusinessRoleCode): TextPair => BUSINESS_ROLE_LABELS[role] ?? [role, role];
export const adminRoleLabel = (role: AdminRole): TextPair => ADMIN_ROLE_LABELS[role] ?? [role, role];

/** The label of a holding kind. */
export function kindLabel(kind: string): TextPair {
  const key = `kind_${kind}` as keyof typeof TEXT;
  return (TEXT[key] as TextPair | undefined) ?? [kind, kind];
}

/** The code of a system slug, else the slug in upper case. */
export function systemCode(systems: readonly SystemRef[], slug: string): string {
  return systems.find((s) => s.slug === slug)?.code ?? slug.toUpperCase();
}

/** An instant as a day in the interface language. */
export function dayOf(ctx: HostContext, iso: string | null | undefined): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** The text of a refusal: the server's message, and its detail when the message is only the problem title. */
export function errorText(ctx: HostContext, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/**
 * The text of a refusal with the server's field messages (`errors[]`), for confirmations that have no field to show
 * them next to. A problem that gives only its title (the same in both languages, such as "Invalid request") leads with
 * a sentence in the interface language instead of the title.
 */
export function refusalText(ctx: HostContext, error: ApiError): string {
  const fields = [...new Set((error.errors ?? []).map((e) => String(e.message ?? '').trim()).filter(Boolean))];
  if (!fields.length) return errorText(ctx, error);
  const titleOnly = error.message[0] === error.message[1] && !error.messageKey;
  const lead = titleOnly ? ctx.li(TEXT.refusedLead) : ctx.li(error.message);
  const parts = titleOnly && error.detail ? [error.detail, ...fields] : fields;
  return `${lead} ${parts.join('; ')}`;
}

/**
 * The management systems whose snapshot is loaded again after a change of a member (D2-08), or null when the
 * snapshot does not change. The organisation snapshot lists in `PEOPLE` the active members with an active business
 * role, with their names and job titles, and the system snapshots name people by their display names. A change of the
 * membership status reloads the organisation snapshot with the systems of the member's active grants and the systems
 * where the member holds open items (`heldIn`); a change of the job title of a member listed in `PEOPLE` reloads the
 * organisation snapshot only (an empty list).
 */
export function snapshotReload(before: Member, after: Member, heldIn: readonly string[] = []): string[] | null {
  const granted = [...before.roles, ...after.roles].filter((g) => g.approvalStatus === 'active').map((g) => g.ms);
  const systems = [...new Set([...granted, ...heldIn])];
  if (before.membershipStatus !== after.membershipStatus) return systems;
  if (after.membershipStatus !== 'active') return null;
  if (before.displayName !== after.displayName) return systems;
  if ((before.jobTitle ?? null) !== (after.jobTitle ?? null) && granted.length) return [];
  return null;
}

/** True for the refusal of the licence user limit (`LIC-USERS`, D-15). */
export const isUserLimit = (error: ApiError | null | undefined): boolean => Boolean(error && error.rule === 'LIC-USERS');

// ---------------------------------------------------------------------------------------------------------------
// Members: search and filters
// ---------------------------------------------------------------------------------------------------------------

export interface MemberFilter {
  q: string;
  status: '' | MembershipState;
  /** '' every role, 'admin', 'none', 'pending', or a business role code. */
  role: string;
  /** '' or a system slug. */
  ms: string;
}

export const EMPTY_FILTER: MemberFilter = { q: '', status: '', role: '', ms: '' };

/** The members a search and the filters keep, in the order given. */
export function filterMembers(members: readonly Member[], f: MemberFilter): Member[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return members.filter((m) => {
    if (words.length && !words.every((w) => `${m.displayName} ${m.email} ${m.handle} ${m.jobTitle ?? ''}`.toLowerCase().includes(w))) return false;
    if (f.status && m.membershipStatus !== f.status) return false;
    const grants = f.ms ? m.roles.filter((g) => g.ms === f.ms) : m.roles;
    if (f.ms && grants.length === 0) return false;
    if (f.role === 'admin') return m.adminRoles.length > 0;
    if (f.role === 'none') return m.adminRoles.length === 0 && m.roles.length === 0;
    if (f.role === 'pending') return grants.some((g) => g.approvalStatus === 'pending_approval');
    if (f.role) return grants.some((g) => g.role === f.role && g.approvalStatus !== 'rejected');
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface InviteForm {
  email: string;
  displayName: string;
  jobTitle: string;
  adminRoles: AdminRole[];
}

export type InviteErrors = Partial<Record<keyof InviteForm, TextPair | string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteErrors(form: InviteForm, lang: Lang): InviteErrors {
  const out: InviteErrors = {};
  const tooLong = (n: number) => TEXT.tooLong[lang === 'id' ? 1 : 0].replace('{n}', String(n));
  if (!EMAIL.test(form.email.trim()) || form.email.trim().length > 254) out.email = TEXT.badEmail;
  if (!form.displayName.trim()) out.displayName = TEXT.required;
  else if (form.displayName.trim().length > 150) out.displayName = tooLong(150);
  if (form.jobTitle.trim().length > 150) out.jobTitle = tooLong(150);
  return out;
}

/** `UserCreate` of the invite form. */
export function inviteBody(form: InviteForm): UserCreate {
  const job = form.jobTitle.trim();
  return { email: form.email.trim(), displayName: form.displayName.trim(), ...(job ? { jobTitle: job } : {}), adminRoles: ADMIN_ROLES.filter((r) => form.adminRoles.includes(r)) };
}

export interface EditForm {
  jobTitle: string;
  adminRoles: AdminRole[];
}

/** Whether the session may change the job title (a global field, F.6): only for an active member of this organisation only. */
export function jobTitleBlock(ctx: HostContext, member: Member): TextPair | null {
  if (isSelf(ctx, member)) return null;
  if (member.membershipStatus === 'invited') return TEXT.jobInvited;
  if (member.otherMemberships) return TEXT.jobLocked;
  return null;
}

/** `UserPatch` of the changed fields of the edit form; null when nothing changed. */
export function editPatch(ctx: HostContext, form: EditForm, member: Member): UserPatch | null {
  const patch: UserPatch = {} as UserPatch;
  const roles = ADMIN_ROLES.filter((r) => form.adminRoles.includes(r));
  const before = ADMIN_ROLES.filter((r) => member.adminRoles.includes(r));
  if (roles.join(',') !== before.join(',')) patch.adminRoles = roles;
  const job = form.jobTitle.trim();
  if (!jobTitleBlock(ctx, member) && job !== (member.jobTitle ?? '')) patch.jobTitle = job || null;
  return Object.keys(patch).length ? patch : null;
}

export interface GrantForm {
  ms: string;
  role: '' | BusinessRoleCode;
  isPrimary: boolean;
  validUntil: string;
}

export type GrantErrors = Partial<Record<keyof GrantForm, TextPair | string>>;

export function grantErrors(form: GrantForm, member: Member, today: string | null | undefined, ctx: HostContext): GrantErrors {
  const out: GrantErrors = {};
  if (!form.ms) out.ms = TEXT.required;
  if (!form.role) out.role = TEXT.required;
  if (form.role === 'external_auditor' && !form.validUntil) out.validUntil = TEXT.required;
  else if (form.validUntil && today && form.validUntil <= today) out.validUntil = TEXT.futureDate;
  if (form.ms && form.role && member.roles.some((g) => g.ms === form.ms && g.role === form.role && g.approvalStatus !== 'rejected')) {
    out.role = ctx.fill(TEXT.alreadyHolds, { name: member.displayName });
  }
  return out;
}

/** The end of a chosen day in UTC, as the instant `validUntil` of a grant. */
export function endOfDay(day: string): string {
  return `${day}T23:59:59Z`;
}

/** `RoleGrant` of the grant form. */
export function grantBody(form: GrantForm, member: Member): RoleGrant {
  return {
    user: member.handle,
    role: form.role as BusinessRoleCode,
    ...(form.role === 'ms_manager' && form.isPrimary ? { isPrimary: true } : {}),
    ...(form.validUntil ? { validUntil: endOfDay(form.validUntil) } : {}),
  } as RoleGrant;
}

// ---------------------------------------------------------------------------------------------------------------
// Roles and responsibilities CSV
// ---------------------------------------------------------------------------------------------------------------

/** A CSV cell: quoted when needed, with spreadsheet formulas neutralised (F.15). */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The roles and responsibilities register: one row per active role grant (person, role, system, primary, granted by,
 * since, valid until) and one per administration role, people in name order. "Granted by" is the person whose action
 * made the grant apply: the approver of a four-eyes grant, else the person who granted it.
 */
export function rolesCsv(members: readonly Member[], systems: readonly SystemRef[], history: Readonly<Record<string, GrantHistory>>, lang: Lang): string {
  const t = (p: TextPair) => p[lang === 'id' ? 1 : 0];
  const head = [TEXT.csvPerson, TEXT.csvEmail, TEXT.csvRole, TEXT.csvSystem, TEXT.csvPrimary, TEXT.csvGrantedBy, TEXT.csvSince, TEXT.csvValidUntil].map(t);
  const rows: string[][] = [];
  const people = [...members].filter((m) => m.membershipStatus === 'active').sort((a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle));
  for (const m of people) {
    for (const role of ADMIN_ROLES.filter((r) => m.adminRoles.includes(r))) {
      rows.push([m.displayName, m.email, t(adminRoleLabel(role)), t(TEXT.csvOrganisation), '', '', '', '']);
    }
    for (const g of m.roles.filter((r) => r.approvalStatus === 'active')) {
      const h = history[g.grantId];
      rows.push([
        m.displayName,
        m.email,
        t(roleLabel(g.role)),
        systemCode(systems, g.ms),
        g.role === 'ms_manager' ? t(g.isPrimary ? TEXT.csvYes : TEXT.csvNo) : '',
        h?.decidedBy?.name ?? h?.requestedBy?.name ?? '',
        (h?.decidedAt ?? h?.requestedAt ?? '').slice(0, 10),
        (g.validUntil ?? '').slice(0, 10),
      ]);
    }
  }
  return `\uFEFF${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
