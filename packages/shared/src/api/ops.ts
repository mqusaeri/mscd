// Area `ops` (owner from wave 11: WP-34): operations endpoints of the platform operator (D.2 `OpsHealth`, D.3
// "Operations"). Milestone 2 (D.1, D.2) adds the organisation lifecycle of the platform operator: list and create
// (M2-06), the second-factor reset of an account with several memberships (M2-06), and detail, status changes and
// status history (M2-S09, SaaS track). Every organisation route answers 409 `conflict` with messageKey
// `single_tenancy` when tenancy.mode is single (J.6). Milestone 2 section L (M2-19) adds the accounts of the service
// and the platform operators: the account list and detail, the actions on one account and adding and removing an
// operator. These work in both tenancy modes.
import { z } from 'zod';
import {
  AccountStatus, AuthMethod, DomainStatus, EntitlementSource, MembershipStatus, OpsRunnableJob, OrgRole, OrganizationStatus, SessionState, UserKind,
} from '../enums.js';
import {
  BinaryBody, Instant, IsoDate, NoBody, OrgSlug, Uuid, commandResultWith, defineRoute, named, pageOf, pageQueryShape,
} from './common.js';
import type { RouteDef } from './common.js';
import { LicenceState } from './license.js';

export const QueueStats = named(
  'QueueStats',
  z.object({ name: z.string(), waiting: z.int().min(0), active: z.int().min(0), failed: z.int().min(0), oldestAgeSeconds: z.number().min(0) }),
  'Job queue statistics (E.1 JobQueue.stats)',
  { valid: [{ name: 'freshness.recompute', waiting: 2, active: 1, failed: 0, oldestAgeSeconds: 4.2 }], invalid: [{ name: 'x', waiting: -1, active: 0, failed: 0, oldestAgeSeconds: 0 }] },
);
export type QueueStats = z.infer<typeof QueueStats>;

export const OpsHealth = named(
  'OpsHealth',
  z.object({
    components: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'down']), detail: z.string() })),
    migrations: z.array(z.object({ schema: z.string(), latest: z.string().nullable(), expected: z.string().nullable() })),
    queues: z.array(QueueStats),
    licences: z.array(z.object({ org: OrgSlug, state: LicenceState, validUntil: IsoDate })),
  }),
  'Installation health for the platform operator (D.2)',
  {
    valid: [{ components: [{ name: 'database', status: 'ok', detail: 'SELECT 1 in 2 ms' }], migrations: [{ schema: 'platform', latest: '0004_operations', expected: '0004_operations' }], queues: [], licences: [{ org: 'ndt', state: 'valid', validUntil: '2027-03-31' }] }],
    invalid: [{ components: [{ name: 'database', status: 'green', detail: '' }], migrations: [], queues: [], licences: [] }],
  },
);
export type OpsHealth = z.infer<typeof OpsHealth>;

export const JobRunParams = named('JobRunParams', z.strictObject({ name: OpsRunnableJob }), 'Path parameter {name}: a job of the operator allow-list', {
  valid: [{ name: 'drift.evaluate' }],
  invalid: [{ name: 'pack.install' }, { name: 'rm -rf' }],
});
export type JobRunParams = z.infer<typeof JobRunParams>;

export const JobRunRequest = named('JobRunRequest', z.strictObject({ org: OrgSlug.optional() }), 'POST /ops/jobs/{name}/run body: only the organisation, never a free payload', {
  valid: [{}, { org: 'ndt' }],
  invalid: [{ payload: {} }, { org: 'NDT' }],
});
export type JobRunRequest = z.infer<typeof JobRunRequest>;

export const JobRunResponse = named('JobRunResponse', z.object({ jobId: z.string().min(1) }), 'Id of the queued job', {
  valid: [{ jobId: 'ob-42' }],
  invalid: [{}],
});
export type JobRunResponse = z.infer<typeof JobRunResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Organisations (Milestone 2 D.1, D.2, K.6)
// ---------------------------------------------------------------------------------------------------------------

/** Name of a plan preset of the profile key `license.plans` (Milestone 2 D.3). */
export const PlanPresetName = named('PlanPresetName', z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), 'Name of a plan preset of license.plans', {
  valid: ['trial', 'standard'],
  invalid: ['Trial', '', 'a b'],
});
export type PlanPresetName = z.infer<typeof PlanPresetName>;

export const OrgParams = named('OrgParams', z.strictObject({ org: OrgSlug }), 'Path parameter {org}: the organisation slug', {
  valid: [{ org: 'ndt' }],
  invalid: [{ org: 'NDT' }, {}],
});
export type OrgParams = z.infer<typeof OrgParams>;

export const OpsOrganizationListQuery = named(
  'OpsOrganizationListQuery',
  z.strictObject({ ...pageQueryShape, status: OrganizationStatus.optional(), q: z.string().trim().min(1).max(100).optional() }),
  'GET /ops/organizations query: status filter and search by slug or name',
  { valid: [{}, { status: 'suspended', q: 'nusantara' }], invalid: [{ status: 'deleted' }, { sort: 'slug' }] },
);
export type OpsOrganizationListQuery = z.infer<typeof OpsOrganizationListQuery>;

const EXAMPLE_OPS_ORG = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active',
  licence: { state: 'valid', validUntil: '2027-03-31' }, memberCount: 86, systemCount: 4, plan: 'standard', validUntil: '2027-03-31',
  verifiedDomains: ['nusantaradigital.co.id'], createdAt: '2026-02-01T03:00:00Z',
} as const;

export const OpsOrganizationItem = named(
  'OpsOrganizationItem',
  z.object({
    id: Uuid,
    slug: OrgSlug,
    name: z.string(),
    status: OrganizationStatus,
    licence: z.object({ state: LicenceState, validUntil: IsoDate }).nullable(),
    memberCount: z.int().min(0),
    systemCount: z.int().min(0),
    plan: z.string().nullable(),
    validUntil: IsoDate.nullable(),
    verifiedDomains: z.array(z.string()),
    createdAt: Instant,
  }),
  'Organisation row of the operator console: status, licence state, plan and validity of the entitlement, members, systems, verified domains (Milestone 2 D.1, D.2)',
  {
    valid: [EXAMPLE_OPS_ORG, { ...EXAMPLE_OPS_ORG, status: 'suspended', licence: null, plan: null, validUntil: null, verifiedDomains: [] }],
    invalid: [{ ...EXAMPLE_OPS_ORG, status: 'deleted' }, { ...EXAMPLE_OPS_ORG, memberCount: -1 }],
  },
);
export type OpsOrganizationItem = z.infer<typeof OpsOrganizationItem>;

export const OpsOrganizationCreate = named(
  'OpsOrganizationCreate',
  z.strictObject({
    slug: OrgSlug,
    name: z.string().trim().min(1).max(200),
    timeZone: z.string().trim().min(1).max(64),
    siteCount: z.int().min(0).max(10_000),
    firstAdmin: z.strictObject({ email: z.email().max(254), displayName: z.string().trim().min(1).max(150) }),
    preset: PlanPresetName.optional(),
  }),
  'POST /ops/organizations body: the organisation (slug permanent) and its first administrator, who is invited; preset names a plan of license.plans (Milestone 2 D.2)',
  {
    valid: [
      { slug: 'bank_sentosa', name: 'PT Bank Sentosa', timeZone: 'Asia/Jakarta', siteCount: 3, firstAdmin: { email: 'it.admin@banksentosa.co.id', displayName: 'Andi Wijaya' } },
      { slug: 'klinik_sehat', name: 'Klinik Sehat', timeZone: 'Asia/Makassar', siteCount: 1, firstAdmin: { email: 'admin@kliniksehat.id', displayName: 'Sari Dewi' }, preset: 'trial' },
    ],
    invalid: [
      { slug: 'Bank', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'a@b.co', displayName: 'A' } },
      { slug: 'bank_sentosa', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1 },
      { slug: 'bank_sentosa', name: 'x', timeZone: 'Asia/Jakarta', siteCount: 1, firstAdmin: { email: 'not-mail', displayName: 'A' } },
    ],
  },
);
export type OpsOrganizationCreate = z.infer<typeof OpsOrganizationCreate>;

export const OpsOrganizationCreateResult = named(
  'OpsOrganizationCreateResult',
  commandResultWith(z.object({
    id: Uuid,
    slug: OrgSlug,
    invitationSent: z.boolean(),
    /** Only when mail.required is false and mail is off: the one-time invitation link (never on SaaS). */
    invitationUrl: z.url().optional(),
    /** The entitlement written from `preset` (Milestone 2 D.2, M2-S09); absent without a preset. */
    plan: z.object({ name: z.string().nullable(), validFrom: IsoDate, validUntil: IsoDate.nullable() }).optional(),
  })),
  'Result of POST /ops/organizations: the new organisation, whether the invitation was emailed, and the message that the slug is permanent (Milestone 2 D.2)',
  {
    valid: [
      { ok: true, changed: [], message: ['Organisation created. The slug bank_sentosa cannot be changed.', 'Organisasi dibuat. Slug bank_sentosa tidak dapat diubah.'], data: { id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', slug: 'bank_sentosa', invitationSent: true } },
      { ok: true, changed: [], data: { id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', slug: 'klinik_sehat', invitationSent: true, plan: { name: 'trial', validFrom: '2026-10-28', validUntil: '2026-11-26' } } },
    ],
    invalid: [{ ok: true, changed: [], data: { slug: 'bank_sentosa' } }],
  },
);
export type OpsOrganizationCreateResult = z.infer<typeof OpsOrganizationCreateResult>;

export const OpsResetMfaRequest = named(
  'OpsResetMfaRequest',
  z.strictObject({ email: z.email().max(254), reason: z.string().trim().min(10).max(500) }),
  'POST /ops/users/reset-mfa body: the account and the reason, recorded with auth.mfa_reset (Milestone 2 D.1)',
  { valid: [{ email: 'rina.kusuma@nusantaradigital.co.id', reason: 'Lost phone, identity checked by video call' }], invalid: [{ email: 'rina', reason: 'Lost phone, identity checked' }, { email: 'a@b.co', reason: 'short' }] },
);
export type OpsResetMfaRequest = z.infer<typeof OpsResetMfaRequest>;

const EXAMPLE_OPS_DETAIL = {
  id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active', region: 'id',
  createdAt: '2026-02-01T03:00:00Z', memberCount: 86, systemCount: 4,
  entitlement: { plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validUntil: '2027-03-31' },
  domains: [{ domain: 'nusantaradigital.co.id', status: 'verified' }], lastSignInAt: '2026-10-27T01:12:00Z',
} as const;

export const OpsOrganizationDetail = named(
  'OpsOrganizationDetail',
  z.object({
    id: Uuid,
    slug: OrgSlug,
    name: z.string(),
    status: OrganizationStatus,
    region: z.string().nullable(),
    createdAt: Instant,
    memberCount: z.int().min(0),
    systemCount: z.int().min(0),
    entitlement: z.object({
      plan: z.string().nullable(), source: EntitlementSource, maxUsers: z.int().min(0), maxManagementSystems: z.int().min(0), validUntil: IsoDate.nullable(),
    }).nullable(),
    domains: z.array(z.object({ domain: z.string(), status: DomainStatus })),
    lastSignInAt: Instant.nullable(),
  }),
  'GET /ops/organizations/{org}: status, region, created date, member count, system count, entitlement summary, domains and last sign-in (Milestone 2 D.1)',
  {
    valid: [EXAMPLE_OPS_DETAIL, { ...EXAMPLE_OPS_DETAIL, status: 'offboarding', region: null, entitlement: null, domains: [], lastSignInAt: null }],
    invalid: [{ ...EXAMPLE_OPS_DETAIL, status: 'paused' }, { ...EXAMPLE_OPS_DETAIL, domains: [{ domain: 'x.id', status: 'ok' }] }],
  },
);
export type OpsOrganizationDetail = z.infer<typeof OpsOrganizationDetail>;

export const OrganizationStatusChange = named(
  'OrganizationStatusChange',
  z.strictObject({ status: OrganizationStatus, reason: z.string().trim().min(3).max(500), confirmSlug: OrgSlug.optional() }),
  'POST /ops/organizations/{org}/status body: the target status of J.8 with a reason; offboarding and archived also need confirmSlug equal to the slug (Milestone 2 D.1, J.8)',
  {
    valid: [{ status: 'suspended', reason: 'Invoice overdue by 60 days' }, { status: 'offboarding', reason: 'Contract ended on 30 Sep 2026', confirmSlug: 'ndt' }],
    invalid: [{ status: 'deleted', reason: 'x'.repeat(10) }, { status: 'suspended' }, { status: 'suspended', reason: 'ok', extra: true }],
  },
);
export type OrganizationStatusChange = z.infer<typeof OrganizationStatusChange>;

const EXAMPLE_STATUS_RESULT = {
  ok: true,
  changed: [],
  message: ['Organisation ndt moved from active to suspended. 12 sessions were ended. 2 of 2 Tenant Admins were emailed.', 'Organisasi ndt dipindahkan dari active ke suspended. 12 sesi diakhiri. 2 dari 2 Tenant Admin dikirimi email.'],
  data: { slug: 'ndt', from: 'active', to: 'suspended', sessionsRevoked: 12, tenantAdmins: 2, tenantAdminsEmailed: 2 },
} as const;

export const OrganizationStatusChangeResult = named(
  'OrganizationStatusChangeResult',
  commandResultWith(z.object({
    slug: OrgSlug,
    from: OrganizationStatus,
    to: OrganizationStatus,
    /** Sessions whose current organisation was this one, ended by `suspended` and `archived` (0 for other moves). */
    sessionsRevoked: z.int().min(0),
    /** Active Tenant Admins of the organisation, who get the `organization_status_changed` notice. */
    tenantAdmins: z.int().min(0),
    /** Tenant Admins whose email went out (fewer than `tenantAdmins` when mail failed). */
    tenantAdminsEmailed: z.int().min(0),
  })),
  'Result of POST /ops/organizations/{org}/status: the move, the sessions it ended and the Tenant Admins told by email (Milestone 2 J.8, K.6)',
  {
    valid: [EXAMPLE_STATUS_RESULT, { ...EXAMPLE_STATUS_RESULT, data: { slug: 'ndt', from: 'suspended', to: 'active', sessionsRevoked: 0, tenantAdmins: 1, tenantAdminsEmailed: 0 } }],
    invalid: [{ ...EXAMPLE_STATUS_RESULT, data: { ...EXAMPLE_STATUS_RESULT.data, to: 'paused' } }, { ok: true, changed: [], data: { slug: 'ndt' } }],
  },
);
export type OrganizationStatusChangeResult = z.infer<typeof OrganizationStatusChangeResult>;

export const OrganizationStatusEventItem = named(
  'OrganizationStatusEventItem',
  z.object({
    id: Uuid,
    from: OrganizationStatus,
    to: OrganizationStatus,
    reason: z.string(),
    actor: z.object({ handle: z.string(), displayName: z.string() }).nullable(),
    at: Instant,
  }),
  'One status change of an organisation (platform.organization_status_event, Milestone 2 D.3)',
  {
    valid: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'suspended', reason: 'Invoice overdue by 60 days', actor: { handle: 'ops.owner', displayName: 'Platform owner' }, at: '2026-10-20T03:00:00Z' }],
    invalid: [{ id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', from: 'active', to: 'paused', reason: 'x', actor: null, at: '2026-10-20T03:00:00Z' }],
  },
);
export type OrganizationStatusEventItem = z.infer<typeof OrganizationStatusEventItem>;

export const OrganizationEventsQuery = named('OrganizationEventsQuery', z.strictObject(pageQueryShape), 'GET /ops/organizations/{org}/events query (paging)', {
  valid: [{}, { page: '2' }],
  invalid: [{ status: 'active' }],
});
export type OrganizationEventsQuery = z.infer<typeof OrganizationEventsQuery>;

const op = { owner: 'WP-34' as const, auth: 'session' as const, scope: 'platform' as const };

export const opsHealthRoute = defineRoute({ ...op, id: 'ops.health', method: 'GET', path: '/api/v1/ops/health', summary: 'Components, migrations, queues and licence states', permission: 'ops.read', response: OpsHealth, errors: [] });
export const opsQueuesRoute = defineRoute({ ...op, id: 'ops.queues', method: 'GET', path: '/api/v1/ops/queues', summary: 'Queue statistics', permission: 'ops.read', response: z.array(QueueStats), errors: [] });
export const opsJobRunRoute = defineRoute({
  ...op, id: 'ops.jobs.run', method: 'POST', path: '/api/v1/ops/jobs/:name/run', summary: 'Run an allow-listed job now (audited ops.job_run)',
  permission: 'ops.jobs.run', params: JobRunParams, body: JobRunRequest, response: JobRunResponse, status: 202, errors: [404, 409, 422],
});
export const opsDiagnosticsRoute = defineRoute({
  ...op, id: 'ops.diagnostics', method: 'POST', path: '/api/v1/ops/diagnostics',
  summary: 'Diagnostics archive (.tar.gz): profile without secrets, versions, migration state, queue stats, redacted log lines, metrics (audited)',
  permission: 'ops.read', response: BinaryBody, responseType: 'application/gzip', file: true, errors: [],
});

const opM2 = { auth: 'session' as const, scope: 'platform' as const };

export const opsOrganizationsListRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.organizations.list', method: 'GET', path: '/api/v1/ops/organizations',
  summary: 'Organisations with status, licence state, plan, member count, systems and verified domains (409 single_tenancy in single tenancy)',
  permission: 'ops.read', query: OpsOrganizationListQuery, response: pageOf(OpsOrganizationItem), errors: [409],
});
export const opsOrganizationsCreateRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.organizations.create', method: 'POST', path: '/api/v1/ops/organizations',
  summary: 'Create an organisation with local sign-in allowed and invite its first administrator (409 single_tenancy, 409 mail_required, 409 org_exists; 503 when the storage gateway or the database owner role is unavailable; audited ops.organization_created)',
  permission: 'ops.tenants.manage', body: OpsOrganizationCreate, response: OpsOrganizationCreateResult, status: 201, errors: [409, 422, 503], idempotent: true,
});
export const opsUsersResetMfaRoute = defineRoute({
  ...opM2, owner: 'M2-06', id: 'ops.users.reset-mfa', method: 'POST', path: '/api/v1/ops/users/reset-mfa',
  summary: 'Reset the second factor of an account found by email (404 when it has no factor), ending its sessions and emailing the account (audited auth.mfa_reset with the reason)',
  permission: 'ops.users.manage', body: OpsResetMfaRequest, response: NoBody, status: 204, errors: [404, 422],
});
export const opsOrganizationsGetRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.get', method: 'GET', path: '/api/v1/ops/organizations/:org',
  summary: 'One organisation: status, region, created date, members, systems, entitlement summary, domains, last sign-in',
  permission: 'ops.read', params: OrgParams, response: OpsOrganizationDetail, errors: [404, 409],
});
export const opsOrganizationsStatusRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.status', method: 'POST', path: '/api/v1/ops/organizations/:org/status',
  summary:
    'Move the organisation along the status machine of J.8 with a reason (409 transition-not-allowed invalid_status_transition, 422 confirmation_mismatch); suspended and archived end the sessions of the organisation; the Tenant Admins are told by email (audited ops.organization_status_changed)',
  permission: 'ops.tenants.manage', params: OrgParams, body: OrganizationStatusChange, response: OrganizationStatusChangeResult, errors: [404, 409, 422],
});
export const opsOrganizationsEventsRoute = defineRoute({
  ...opM2, owner: 'M2-S09', id: 'ops.organizations.events', method: 'GET', path: '/api/v1/ops/organizations/:org/events',
  summary: 'Status history of the organisation, newest first',
  permission: 'ops.read', params: OrgParams, query: OrganizationEventsQuery, response: pageOf(OrganizationStatusEventItem), errors: [404, 409],
});


// ---------------------------------------------------------------------------------------------------------------
// Accounts and platform operators of the service (Milestone 2 section L, M2-19)
// ---------------------------------------------------------------------------------------------------------------

/** The reason of an operator action on an account, kept in its platform audit entry (3 to 500 characters). */
export const OpsActionReason = named('OpsActionReason', z.string().trim().min(3).max(500), 'Reason of an operator action, 3 to 500 characters, recorded in the platform audit entry', {
  valid: ['Lost phone, identity checked by video call', 'Fix'],
  invalid: ['ok', '', 'x'.repeat(501)],
});

export const OpsReasonBody = named('OpsReasonBody', z.strictObject({ reason: OpsActionReason }), 'Body of an operator action on an account: the reason (Milestone 2 M2-19)', {
  valid: [{ reason: 'Asked by the Tenant Admin of ndt in ticket 4411' }],
  invalid: [{}, { reason: 'no' }, { reason: 'Asked by the Tenant Admin', extra: true }],
});
export type OpsReasonBody = z.infer<typeof OpsReasonBody>;

export const AccountParams = named('AccountParams', z.strictObject({ id: Uuid }), 'Path parameter {id}: the account (platform.app_user.id)', {
  valid: [{ id: '00000000-0000-4000-8000-0000000f0019' }],
  invalid: [{ id: 'rina' }, {}],
});
export type AccountParams = z.infer<typeof AccountParams>;

export const AccountInvitationParams = named(
  'AccountInvitationParams',
  z.strictObject({ id: Uuid, org: OrgSlug }),
  'Path parameters {id} and {org}: the account and the organisation of its pending membership',
  { valid: [{ id: '00000000-0000-4000-8000-0000000f0019', org: 'ndt' }], invalid: [{ id: '00000000-0000-4000-8000-0000000f0019' }, { id: 'x', org: 'ndt' }] },
);
export type AccountInvitationParams = z.infer<typeof AccountInvitationParams>;

export const OpsAccountListQuery = named(
  'OpsAccountListQuery',
  z.strictObject({
    ...pageQueryShape,
    q: z.string().trim().min(1).max(100).optional(),
    org: OrgSlug.optional(),
    status: AccountStatus.optional(),
    kind: UserKind.optional(),
  }),
  'GET /ops/accounts query: search by name or email, filters by organisation, account status and kind, paging',
  { valid: [{}, { q: 'rina', org: 'ndt', status: 'active', kind: 'person', page: '2', pageSize: '25' }], invalid: [{ status: 'locked' }, { kind: 'robot' }, { org: 'NDT' }, { sort: 'email' }] },
);
export type OpsAccountListQuery = z.infer<typeof OpsAccountListQuery>;

export const OpsAccountMembership = named(
  'OpsAccountMembership',
  z.object({ org: OrgSlug, orgName: z.string(), status: MembershipStatus, adminRoles: z.array(OrgRole) }),
  'One membership of an account: the organisation, the membership status and the admin roles; never the business roles inside the organisation',
  { valid: [{ org: 'ndt', orgName: 'PT Nusantara Digital Teknologi', status: 'active', adminRoles: ['tenant_admin'] }], invalid: [{ org: 'ndt', orgName: 'x', status: 'gone', adminRoles: [] }] },
);
export type OpsAccountMembership = z.infer<typeof OpsAccountMembership>;

const EXAMPLE_ACCOUNT = {
  id: '00000000-0000-4000-8000-0000000f0019', handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', displayName: 'Rina Kusuma', kind: 'person',
  status: 'active', mfaEnrolled: true, locked: false, lastSignInAt: '2026-10-29T02:10:00Z', createdAt: '2026-02-01T03:00:00Z', platformOperator: false,
  memberships: [{ org: 'ndt', orgName: 'PT Nusantara Digital Teknologi', status: 'active', adminRoles: ['tenant_admin'] }], etag: 'W/"1793239800000"',
} as const;

const accountShape = {
  id: Uuid,
  handle: z.string(),
  email: z.string(),
  displayName: z.string(),
  kind: UserKind,
  status: AccountStatus,
  /** A confirmed second factor is set up. */
  mfaEnrolled: z.boolean(),
  /** Locked now after failed passwords or second-factor codes. */
  locked: z.boolean(),
  lastSignInAt: Instant.nullable(),
  createdAt: Instant,
  platformOperator: z.boolean(),
  memberships: z.array(OpsAccountMembership),
  /** Weak ETag of the account row, for `If-Match` of the status change. */
  etag: z.string(),
};

export const OpsAccountItem = named(
  'OpsAccountItem',
  z.object(accountShape),
  'Account row of the operator console: who, kind and status, second factor, lock, last sign-in, operator role and memberships; no password hash, factor secret or business role (Milestone 2 M2-19)',
  {
    valid: [EXAMPLE_ACCOUNT, { ...EXAMPLE_ACCOUNT, kind: 'system', status: 'active', mfaEnrolled: false, lastSignInAt: null, memberships: [] }],
    invalid: [{ ...EXAMPLE_ACCOUNT, status: 'locked' }, { ...EXAMPLE_ACCOUNT, memberships: [{ org: 'ndt', orgName: 'x', status: 'active', adminRoles: ['ms_manager'] }] }],
  },
);
export type OpsAccountItem = z.infer<typeof OpsAccountItem>;

export const OpsAccountSession = named(
  'OpsAccountSession',
  z.object({
    startedAt: Instant,
    lastSeenAt: Instant,
    method: AuthMethod,
    state: SessionState,
    /** The network address cut to /24 (IPv4) or /48 (IPv6); null when unknown. */
    network: z.string().nullable(),
    /** Browser and system read from the user agent, such as "Chrome 130, Windows"; null when unknown. */
    browser: z.string().nullable(),
    /** The current organisation of the session; null without one. */
    org: OrgSlug.nullable(),
  }),
  'An open session of an account as the operator sees it: start, last activity, sign-in method, network and browser (Milestone 2 M2-19)',
  {
    valid: [{ startedAt: '2026-10-29T02:10:00Z', lastSeenAt: '2026-10-29T02:40:00Z', method: 'local', state: 'active', network: '203.0.113.0/24', browser: 'Firefox 131, Linux', org: 'ndt' }],
    invalid: [{ startedAt: '2026-10-29T02:10:00Z', lastSeenAt: '2026-10-29T02:40:00Z', method: 'magic', state: 'active', network: null, browser: null, org: null }],
  },
);
export type OpsAccountSession = z.infer<typeof OpsAccountSession>;

export const OpsAccountAuditEntry = named(
  'OpsAccountAuditEntry',
  z.object({
    at: Instant,
    action: z.string(),
    actorKind: z.enum(['user', 'system', 'guest', 'operator']),
    actor: z.object({ handle: z.string(), displayName: z.string() }).nullable(),
    org: OrgSlug.nullable(),
    /** The reason of an operator action; null for other entries. */
    reason: z.string().nullable(),
  }),
  'A platform audit entry about an account, newest first (Milestone 2 M2-19)',
  {
    valid: [{ at: '2026-10-29T02:10:00Z', action: 'auth.mfa_reset', actorKind: 'operator', actor: { handle: 'ops.owner', displayName: 'Platform owner' }, org: null, reason: 'Lost phone, identity checked by video call' }],
    invalid: [{ at: '2026-10-29T02:10:00Z', action: 'auth.login', actorKind: 'robot', actor: null, org: null, reason: null }],
  },
);
export type OpsAccountAuditEntry = z.infer<typeof OpsAccountAuditEntry>;

export const OpsAccountDetail = named(
  'OpsAccountDetail',
  z.object({ ...accountShape, sessions: z.array(OpsAccountSession), audit: z.array(OpsAccountAuditEntry) }),
  'GET /ops/accounts/{id}: the account row, its open sessions and the latest platform audit entries about it (Milestone 2 M2-19)',
  {
    valid: [{ ...EXAMPLE_ACCOUNT, sessions: [], audit: [] }],
    invalid: [{ ...EXAMPLE_ACCOUNT, sessions: [{ startedAt: 'yesterday' }], audit: [] }, EXAMPLE_ACCOUNT],
  },
);
export type OpsAccountDetail = z.infer<typeof OpsAccountDetail>;

export const OpsAccountStatusChange = named(
  'OpsAccountStatusChange',
  z.strictObject({ status: z.enum(['active', 'disabled']), reason: OpsActionReason }),
  'POST /ops/accounts/{id}/status body: disabled ends every session of the account; active enables it again (Milestone 2 M2-19)',
  { valid: [{ status: 'disabled', reason: 'The person left every customer organisation' }], invalid: [{ status: 'invited', reason: 'Not possible' }, { status: 'disabled' }] },
);
export type OpsAccountStatusChange = z.infer<typeof OpsAccountStatusChange>;

export const OpsAccountActionResult = named(
  'OpsAccountActionResult',
  commandResultWith(z.object({
    id: Uuid,
    /** Sessions of the account this action ended. */
    sessionsRevoked: z.int().min(0),
    /** True when the email of the action went out. */
    emailed: z.boolean(),
    /** The one-time link, only when mail.required is false and the email did not go out (never on SaaS). */
    link: z.url().optional(),
    /** When the link stops working. */
    expiresAt: Instant.optional(),
    /** The account status after the action. */
    status: AccountStatus,
  })),
  'Result of an operator action on an account: the sessions ended, whether the email went out and the account status (Milestone 2 M2-19)',
  {
    valid: [
      { ok: true, changed: [], message: ['The account was disabled. 2 sessions were ended.', 'Akun dinonaktifkan. 2 sesi diakhiri.'], data: { id: '00000000-0000-4000-8000-0000000f0019', sessionsRevoked: 2, emailed: false, status: 'disabled' } },
      { ok: true, changed: [], data: { id: '00000000-0000-4000-8000-0000000f0019', sessionsRevoked: 0, emailed: false, link: 'https://mscd.example.id/reset-password#token=abc', expiresAt: '2026-10-29T03:00:00Z', status: 'active' } },
    ],
    invalid: [{ ok: true, changed: [], data: { id: '00000000-0000-4000-8000-0000000f0019', sessionsRevoked: -1, emailed: false, status: 'active' } }],
  },
);
export type OpsAccountActionResult = z.infer<typeof OpsAccountActionResult>;

const EXAMPLE_OPERATOR = {
  id: '00000000-0000-4000-8000-0000000f0001', handle: 'ops.owner', email: 'owner@mscd.example', displayName: 'Platform owner', status: 'active',
  mfaEnrolled: true, passwordSet: true, lastSignInAt: '2026-10-29T01:00:00Z', grantedAt: '2026-09-01T03:00:00Z', grantedBy: null, self: true,
} as const;

export const OpsOperatorItem = named(
  'OpsOperatorItem',
  z.object({
    id: Uuid,
    handle: z.string(),
    email: z.string(),
    displayName: z.string(),
    status: AccountStatus,
    mfaEnrolled: z.boolean(),
    /** False while the set-password link of a new operator is not used yet. */
    passwordSet: z.boolean(),
    lastSignInAt: Instant.nullable(),
    grantedAt: Instant,
    /** Who granted the role; null for the command line. */
    grantedBy: z.object({ handle: z.string(), displayName: z.string() }).nullable(),
    /** The signed-in operator's own account. */
    self: z.boolean(),
  }),
  'A platform operator of the service (platform.platform_role), Milestone 2 M2-19',
  {
    valid: [EXAMPLE_OPERATOR, { ...EXAMPLE_OPERATOR, passwordSet: false, mfaEnrolled: false, lastSignInAt: null, grantedBy: { handle: 'ops.owner', displayName: 'Platform owner' }, self: false }],
    invalid: [{ ...EXAMPLE_OPERATOR, status: 'gone' }, { ...EXAMPLE_OPERATOR, grantedAt: null }],
  },
);
export type OpsOperatorItem = z.infer<typeof OpsOperatorItem>;

export const OpsOperatorAdd = named(
  'OpsOperatorAdd',
  z.strictObject({ email: z.email().max(254), name: z.string().trim().min(1).max(150), reason: OpsActionReason }),
  'POST /ops/operators body: the email and name of the operator (a new account gets a set-password link by email) and the reason (Milestone 2 M2-19)',
  {
    valid: [{ email: 'nadia.operator@mscd.example', name: 'Nadia Putri', reason: 'Second operator for the on-call rota' }],
    invalid: [{ email: 'nadia', name: 'Nadia', reason: 'On-call rota' }, { email: 'nadia@mscd.example', name: '', reason: 'On-call rota' }, { email: 'nadia@mscd.example', name: 'Nadia' }],
  },
);
export type OpsOperatorAdd = z.infer<typeof OpsOperatorAdd>;

export const OpsOperatorAddResult = named(
  'OpsOperatorAddResult',
  commandResultWith(z.object({
    id: Uuid,
    handle: z.string(),
    email: z.string(),
    /** True when the account was created now. */
    newAccount: z.boolean(),
    /** True when the email (set-password link, or the notice of the new role) went out. */
    emailed: z.boolean(),
    /** The one-time set-password link, only when mail.required is false and the email did not go out (never on SaaS). */
    link: z.url().optional(),
    expiresAt: Instant.optional(),
  })),
  'Result of POST /ops/operators (Milestone 2 M2-19)',
  {
    valid: [{ ok: true, changed: [], message: ['nadia.operator@mscd.example is now a platform operator.', 'nadia.operator@mscd.example sekarang operator platform.'], data: { id: '00000000-0000-4000-8000-0000000f0002', handle: 'nadia.operator', email: 'nadia.operator@mscd.example', newAccount: true, emailed: true } }],
    invalid: [{ ok: true, changed: [], data: { id: '00000000-0000-4000-8000-0000000f0002' } }],
  },
);
export type OpsOperatorAddResult = z.infer<typeof OpsOperatorAddResult>;

export const OpsOperatorRemoveResult = named(
  'OpsOperatorRemoveResult',
  commandResultWith(z.object({ id: Uuid, sessionsRevoked: z.int().min(0), operatorsLeft: z.int().min(0) })),
  'Result of DELETE /ops/operators/{id}: the sessions of the account ended and the active operators left (Milestone 2 M2-19)',
  {
    valid: [{ ok: true, changed: [], data: { id: '00000000-0000-4000-8000-0000000f0002', sessionsRevoked: 1, operatorsLeft: 2 } }],
    invalid: [{ ok: true, changed: [], data: { id: '00000000-0000-4000-8000-0000000f0002', sessionsRevoked: 1 } }],
  },
);
export type OpsOperatorRemoveResult = z.infer<typeof OpsOperatorRemoveResult>;

const opAccounts = { auth: 'session' as const, scope: 'platform' as const, owner: 'M2-19' as const };

export const opsAccountsListRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.list', method: 'GET', path: '/api/v1/ops/accounts',
  summary: 'Every account of the service, paged, with search by name or email and filters by organisation, account status and kind',
  permission: 'ops.read', query: OpsAccountListQuery, response: pageOf(OpsAccountItem), errors: [],
});
export const opsAccountsGetRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.get', method: 'GET', path: '/api/v1/ops/accounts/:id',
  summary: 'One account with its open sessions (network cut to /24 or /48) and the latest platform audit entries about it',
  permission: 'ops.read', params: AccountParams, response: OpsAccountDetail, errors: [404],
});
export const opsAccountsResetMfaRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.reset-mfa', method: 'POST', path: '/api/v1/ops/accounts/:id/reset-mfa',
  summary: 'Reset the second factor of the account, ending its sessions and emailing it after the commit (emailed says whether the email went out); never the operator\'s own (403 own_account, 409 no_second_factor, system_account; audited auth.mfa_reset with the reason)',
  permission: 'ops.users.manage', params: AccountParams, body: OpsReasonBody, response: OpsAccountActionResult, errors: [404, 409], idempotent: true,
});
export const opsAccountsPasswordResetRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.password-reset', method: 'POST', path: '/api/v1/ops/accounts/:id/password-reset',
  summary: 'Email a one-time link to set a new password (409 mail_required, account_not_active, guest_account, no_membership, local_login_not_allowed, system_account; audited auth.password_reset with the reason)',
  permission: 'ops.users.manage', params: AccountParams, body: OpsReasonBody, response: OpsAccountActionResult, errors: [404, 409], idempotent: true,
});
export const opsAccountsInvitationResendRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.invitation-resend', method: 'POST', path: '/api/v1/ops/accounts/:id/invitations/:org/resend',
  summary: 'Send a new invitation link for a pending membership; the older links stop working (409 mail_required, membership_not_invited, organization_archived; audited user.invited with the reason)',
  permission: 'ops.users.manage', params: AccountInvitationParams, body: OpsReasonBody, response: OpsAccountActionResult, errors: [404, 409], idempotent: true,
});
export const opsAccountsSessionsRevokeRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.sessions-revoke', method: 'POST', path: '/api/v1/ops/accounts/:id/sessions/revoke',
  summary: 'End every session of the account; never the operator\'s own (403 own_account, 409 system_account; audited auth.session_revoked with the reason)',
  permission: 'ops.users.manage', params: AccountParams, body: OpsReasonBody, response: OpsAccountActionResult, errors: [404, 409], idempotent: true,
});
export const opsAccountsStatusRoute = defineRoute({
  ...opAccounts, id: 'ops.accounts.status', method: 'POST', path: '/api/v1/ops/accounts/:id/status',
  summary:
    'Disable the account (every session ends) or enable it again (403 own_account, 409 last_operator, system_account, account_invited for an invited account either way, status_unchanged, 412 with a stale If-Match, 422 LIC-USERS; audited user.updated with the reason)',
  permission: 'ops.users.manage', params: AccountParams, body: OpsAccountStatusChange, response: OpsAccountActionResult, errors: [404, 409, 412, 422], ifMatch: true,
});
export const opsOperatorsListRoute = defineRoute({
  ...opAccounts, id: 'ops.operators.list', method: 'GET', path: '/api/v1/ops/operators',
  summary: 'The platform operators of the service with their second factor, last sign-in and who granted the role',
  permission: 'ops.read', response: z.array(OpsOperatorItem), errors: [],
});
export const opsOperatorsAddRoute = defineRoute({
  ...opAccounts, id: 'ops.operators.add', method: 'POST', path: '/api/v1/ops/operators',
  summary:
    'Make an account a platform operator; a new account gets a set-password link by email (409 mail_required, already_operator, account_disabled, system_account; 503 without the database owner role; audited ops.operator_created with the reason)',
  permission: 'ops.users.manage', body: OpsOperatorAdd, response: OpsOperatorAddResult, status: 201, errors: [409, 503], idempotent: true,
});
export const opsOperatorsRemoveRoute = defineRoute({
  ...opAccounts, id: 'ops.operators.remove', method: 'DELETE', path: '/api/v1/ops/operators/:id',
  summary:
    'End the platform operator role of an account and its sessions; never the operator\'s own, never the last active operator (403 own_account, 409 last_operator; 503 without the database owner role; audited ops.operator_revoked with the reason)',
  permission: 'ops.users.manage', params: AccountParams, body: OpsReasonBody, response: OpsOperatorRemoveResult, errors: [404, 409, 503],
});

export const routes: RouteDef[] = [
  opsHealthRoute, opsQueuesRoute, opsJobRunRoute, opsDiagnosticsRoute,
  opsOrganizationsListRoute, opsOrganizationsCreateRoute, opsUsersResetMfaRoute,
  opsOrganizationsGetRoute, opsOrganizationsStatusRoute, opsOrganizationsEventsRoute,
  opsAccountsListRoute, opsAccountsGetRoute, opsAccountsResetMfaRoute, opsAccountsPasswordResetRoute, opsAccountsInvitationResendRoute,
  opsAccountsSessionsRevokeRoute, opsAccountsStatusRoute, opsOperatorsListRoute, opsOperatorsAddRoute, opsOperatorsRemoveRoute,
];
