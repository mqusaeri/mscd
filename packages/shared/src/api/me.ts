// Area `me` (owner from wave 6: WP-39): the session user, organisation switch (D-26), memberships, preferences and
// the demo persona switch (D-20). Milestone 2 (D.1) adds declining an invited membership, the security overview of
// the account and new recovery codes, built by M2-06.
import { z } from 'zod';
import { AuthMethod, BusinessRole, IdentityProviderKind, OrgRole, PlatformRole, UiRole } from '../enums.js';
import { Organisation } from '../ui/records.js';
import { RolesMap } from '../ui/snapshot.js';
import { EXAMPLE_ME } from '../examples.js';
import { Handle, Instant, MsId, NoBody, OrgSlug, PermissionSet, ProviderSlug, Uuid, defineRoute, named, utf8ByteLength } from './common.js';
import type { RouteDef } from './common.js';


export const MeUser = named(
  'MeUser',
  z.object({ id: Uuid, handle: Handle, email: z.email(), displayName: z.string(), jobTitle: z.string().nullable() }),
  'The session user (D.2 Me.user)',
  { valid: [EXAMPLE_ME.user, { ...EXAMPLE_ME.user, jobTitle: null }], invalid: [{ ...EXAMPLE_ME.user, email: 'rina' }, { ...EXAMPLE_ME.user, handle: 'none' }] },
);
export type MeUser = z.infer<typeof MeUser>;

export const MeOrg = named(
  'MeOrg',
  z.object({ id: Uuid, slug: OrgSlug, name: z.string() }),
  'Current organisation of the session',
  { valid: [EXAMPLE_ME.org], invalid: [{ id: 'ndt', slug: 'ndt', name: 'x' }] },
);
export type MeOrg = z.infer<typeof MeOrg>;

export const MeSession = named(
  'MeSession',
  z.object({ authMethod: AuthMethod, idleExpiresAt: Instant, absoluteExpiresAt: Instant }),
  'How the session was authenticated and when it expires (F.1)',
  { valid: [EXAMPLE_ME.session], invalid: [{ ...EXAMPLE_ME.session, authMethod: 'password' }] },
);
export type MeSession = z.infer<typeof MeSession>;

export const PendingMembership = named(
  'PendingMembership',
  z.object({ org: OrgSlug, name: z.string(), invitedBy: z.string().nullable(), invitedAt: Instant }),
  'An invited membership of another organisation that waits for the session user to accept or decline it: the organisation, the name of the person who invited (null for an operator command) and when (Milestone 2 D.2)',
  {
    valid: [{ org: 'bsd', name: 'PT Bank Sentosa Digital', invitedBy: 'Andi Wijaya', invitedAt: '2026-10-20T03:00:00Z' }, { org: 'rmn', name: 'Rumah Sakit Nusantara', invitedBy: null, invitedAt: '2026-10-21T08:30:00Z' }],
    invalid: [{ org: 'BSD', name: 'x', invitedBy: null, invitedAt: '2026-10-20T03:00:00Z' }, { org: 'bsd', name: 'x', invitedAt: '2026-10-20' }],
  },
);
export type PendingMembership = z.infer<typeof PendingMembership>;

export const Me = named(
  'Me',
  z.object({
    user: MeUser,
    org: MeOrg.nullable(),
    orgs: z.array(Organisation),
    rolesByMs: z.record(MsId, z.array(BusinessRole)),
    uiRoleByMs: z.record(MsId, UiRole),
    adminRoles: z.array(OrgRole),
    platformRoles: z.array(PlatformRole),
    permissions: PermissionSet,
    csrfToken: z.string().min(16),
    session: MeSession,
    personas: RolesMap.optional(),
    preferences: z.record(z.string(), z.unknown()),
    /**
     * Invited memberships of other organisations, oldest first (Milestone 2 D.2). The server always sends the list;
     * it is optional so a client still reads the answer of an older server.
     */
    pendingMemberships: z.array(PendingMembership).optional(),
  }),
  'Session user, current organisation, roles and permissions per system, CSRF token, preferences and the invitations waiting for the user (D.2, Milestone 2 D.2). org is null only for a platform operator without a membership',
  {
    valid: [
      EXAMPLE_ME,
      { ...EXAMPLE_ME, pendingMemberships: [{ org: 'bsd', name: 'PT Bank Sentosa Digital', invitedBy: 'Andi Wijaya', invitedAt: '2026-10-20T03:00:00Z' }] },
      { ...EXAMPLE_ME, personas: { manager: { who: 'rina', label: ['Management System Manager', 'Management System Manager'] }, owner: { who: 'bagus', label: ['Domain Owner', 'Pemilik Domain'] } } },
      { ...EXAMPLE_ME, org: null, orgs: [], rolesByMs: {}, uiRoleByMs: {}, adminRoles: [], platformRoles: ['platform_operator'], permissions: { org: ['ops.read'], ms: {} } },
    ],
    invalid: [
      { ...EXAMPLE_ME, uiRoleByMs: { isms: 'admin' } }, { ...EXAMPLE_ME, csrfToken: undefined }, { ...EXAMPLE_ME, rolesByMs: { isms: ['manager'] } },
      { ...EXAMPLE_ME, pendingMemberships: [{ org: 'bsd' }] },
    ],
  },
);
export type Me = z.infer<typeof Me>;

export const SwitchOrgRequest = named('SwitchOrgRequest', z.strictObject({ org: OrgSlug }), 'PUT /me/org body; 409 reauth-required carries the accepted methods (D-26)', {
  valid: [{ org: 'bsd' }],
  invalid: [{ org: 'BSD' }, {}, { org: 'bsd', ms: 'isms' }],
});
export type SwitchOrgRequest = z.infer<typeof SwitchOrgRequest>;

export const DemoPersonaRequest = named('DemoPersonaRequest', z.strictObject({ role: UiRole }), 'POST /auth/demo/persona body (demo mode, D-20)', {
  valid: [{ role: 'owner' }],
  invalid: [{ role: 'admin' }, {}],
});
export type DemoPersonaRequest = z.infer<typeof DemoPersonaRequest>;

/** Most bytes the preferences document may have (D.3: 16 KiB). */
export const MAX_PREFERENCES_BYTES = 16 * 1024;

export const PreferencesBody = named(
  'PreferencesBody',
  z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/), z.unknown()).refine(
    (v) => utf8ByteLength(JSON.stringify(v)) <= MAX_PREFERENCES_BYTES,
    { message: 'Preferences must not exceed 16 KiB' },
  ),
  'PUT /me/preferences body: preference keys (at most 60 characters) to JSON values, at most 16 KiB in all',
  {
    valid: [{ lang: 'id', density: 'compact' }, {}],
    invalid: [{ 'bad key': 1 }, { blob: 'x'.repeat(MAX_PREFERENCES_BYTES) }],
  },
);
export type PreferencesBody = z.infer<typeof PreferencesBody>;

export const MembershipParams = named('MembershipParams', z.strictObject({ org: OrgSlug }), 'Path parameter {org}', {
  valid: [{ org: 'bsd' }],
  invalid: [{ org: 'B' }],
});

const EXAMPLE_SECURITY = {
  passwordSet: true, ssoOnly: false, authenticatorSetUpAt: '2026-02-03T04:05:06Z', recoveryCodesLeft: 8,
  identities: [{ provider: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak', linkedAt: '2026-03-01T02:00:00Z' }],
} as const;

export const MeSecurity = named(
  'MeSecurity',
  z.object({
    passwordSet: z.boolean(),
    ssoOnly: z.boolean(),
    authenticatorSetUpAt: Instant.nullable(),
    recoveryCodesLeft: z.int().min(0).max(10),
    identities: z.array(z.object({ provider: ProviderSlug, kind: IdentityProviderKind, label: z.string(), linkedAt: Instant })),
  }),
  'GET /me/security: password set, SSO only, authenticator set up at, recovery codes left and linked identities of the session user (Milestone 2 D.1)',
  {
    valid: [EXAMPLE_SECURITY, { ...EXAMPLE_SECURITY, passwordSet: false, ssoOnly: true, authenticatorSetUpAt: null, recoveryCodesLeft: 0, identities: [] }],
    invalid: [{ ...EXAMPLE_SECURITY, recoveryCodesLeft: 11 }, { ...EXAMPLE_SECURITY, identities: [{ provider: 'keycloak', kind: 'ldap', label: 'x', linkedAt: '2026-03-01T02:00:00Z' }] }],
  },
);
export type MeSecurity = z.infer<typeof MeSecurity>;

export const RecoveryCodesRequest = named(
  'RecoveryCodesRequest',
  z.strictObject({ code: z.string().regex(/^\d{6}$/).optional() }),
  'POST /me/mfa/recovery-codes body: the current authenticator code, unless one was given in the last 5 minutes (Milestone 2 D.1)',
  { valid: [{ code: '492039' }, {}], invalid: [{ code: '49203' }, { code: 'abcdef' }, { recoveryCode: 'x' }] },
);
export type RecoveryCodesRequest = z.infer<typeof RecoveryCodesRequest>;

export const RecoveryCodesResponse = named(
  'RecoveryCodesResponse',
  z.object({ codes: z.array(z.string().min(8).max(32)).length(10) }),
  'Ten new recovery codes, shown once; the old codes stop working (Milestone 2 D.1)',
  {
    valid: [{ codes: Array.from({ length: 10 }, (_, i) => `k3f9-${String(i).padStart(4, '0')}-x7qa`) }],
    invalid: [{ codes: ['k3f9-0000-x7qa'] }, { codes: [] }],
  },
);
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;

export const meGetRoute = defineRoute({
  id: 'me.get',
  owner: 'WP-39',
  method: 'GET',
  path: '/api/v1/me',
  summary: 'Session user with roles, UI role and permissions per system, and the invitations waiting for the user',
  auth: 'session',
  response: Me,
  errors: [],
});

export const meSwitchOrgRoute = defineRoute({
  id: 'me.switch-org',
  owner: 'WP-39',
  method: 'PUT',
  path: '/api/v1/me/org',
  summary: 'Switch the current organisation; 409 reauth-required when it does not accept the session authentication (D-26)',
  auth: 'session',
  body: SwitchOrgRequest,
  response: Me,
  errors: [404, 409],
  readOnlyAllowed: true,
});

export const meAcceptMembershipRoute = defineRoute({
  id: 'me.membership.accept',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/me/memberships/:org/accept',
  summary: 'Accept an invited membership of another organisation; 422 LIC-USERS when that organisation is at its licence user limit (D-15)',
  auth: 'session',
  params: MembershipParams,
  response: Me,
  errors: [404, 422],
});

export const meDeclineMembershipRoute = defineRoute({
  id: 'me.membership.decline',
  owner: 'M2-06',
  method: 'POST',
  path: '/api/v1/me/memberships/:org/decline',
  summary: 'Decline an invited membership of another organisation (audited membership.declined)',
  auth: 'session',
  params: MembershipParams,
  response: NoBody,
  status: 204,
  errors: [404],
});

export const meSecurityRoute = defineRoute({
  id: 'me.security',
  owner: 'M2-06',
  method: 'GET',
  path: '/api/v1/me/security',
  summary: 'Security overview of the session user: password, SSO, authenticator, recovery codes left, linked identities',
  auth: 'session',
  response: MeSecurity,
  errors: [],
});

export const meRecoveryCodesRoute = defineRoute({
  id: 'me.recovery-codes',
  owner: 'M2-06',
  method: 'POST',
  path: '/api/v1/me/mfa/recovery-codes',
  summary: 'Ten new recovery codes while keeping the authenticator; the authenticator code is needed unless one was given in the last 5 minutes (422 auth.proof_required or auth.proof_invalid, 409 without an authenticator; audited auth.recovery_codes_regenerated)',
  auth: 'session',
  body: RecoveryCodesRequest,
  response: RecoveryCodesResponse,
  errors: [409, 422, 429],
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 900 }],
});

export const mePreferencesRoute = defineRoute({
  id: 'me.preferences',
  owner: 'WP-11',
  method: 'PUT',
  path: '/api/v1/me/preferences',
  summary: 'Store the preferences of the session user (at most 16 KiB)',
  auth: 'session',
  body: PreferencesBody,
  response: NoBody,
  status: 204,
  errors: [413],
  readOnlyAllowed: true,
});

export const authDemoPersonaRoute = defineRoute({
  id: 'auth.demo-persona',
  owner: 'WP-39',
  method: 'POST',
  path: '/api/v1/auth/demo/persona',
  summary: 'Demo mode: switch to the persona of a UI role; answers 404 when demo mode is off (D-20)',
  auth: 'session',
  body: DemoPersonaRequest,
  response: Me,
  errors: [404],
  readOnlyAllowed: true,
});

export const routes: RouteDef[] = [
  meGetRoute, meSwitchOrgRoute, meAcceptMembershipRoute, mePreferencesRoute, authDemoPersonaRoute,
  meDeclineMembershipRoute, meSecurityRoute, meRecoveryCodesRoute,
];
