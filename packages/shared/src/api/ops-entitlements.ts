// Area `ops-entitlements` (Milestone 2 D.1, SaaS track, built by M2-S10): the per-organisation entitlement of a
// multi-tenant installation (`platform.entitlement`), which is the effective licence of the organisation there, and
// the plan presets of the profile key `license.plans`. The entitlement read carries an `ETag`; a change needs
// `If-Match` (412 when stale, 428 when missing). In single tenancy every route answers 409 `conflict` with
// messageKey `single_tenancy` (J.6).
import { z } from 'zod';
import { EntitlementSource, LicenceFeature, StorageAdapter } from '../enums.js';
import { Instant, IsoDate, OrgSlug, commandResultWith, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { OrgParams, PlanPresetName } from './ops.js';

/**
 * Limits of an entitlement or a plan preset (Milestone 2 D.3 `platform.entitlement`, `license.plans`). `maxUsers` counts
 * active members without guests (product decision 5). An empty `frameworks` list of a preset or of limits set by the
 * operator means every framework; a row from a signed licence keeps the licence's list as it is.
 */
const limitsShape = {
  maxUsers: z.int().min(0),
  maxManagementSystems: z.int().min(0),
  frameworks: z.array(z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/)),
  storageAdapters: z.array(StorageAdapter),
  features: z.array(LicenceFeature),
  /** Requests per user and minute; null uses DEFAULT_RATE_LIMITS. */
  rateUserPerMinute: z.int().min(1).nullable(),
  /** Requests per organisation and minute; null uses DEFAULT_RATE_LIMITS. */
  rateOrgPerMinute: z.int().min(1).nullable(),
  graceDays: z.int().min(0).max(365),
};

const EXAMPLE_LIMITS = {
  maxUsers: 50, maxManagementSystems: 3, frameworks: ['ISO27001', 'ISO9001'], storageAdapters: ['managed_vault', 'm365', 'google_drive'],
  features: ['integrated_mode', 'link_health_monitor'], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30,
} as const;

const EXAMPLE_ENTITLEMENT = {
  organization: 'ndt', plan: 'standard', source: 'preset', ...EXAMPLE_LIMITS, validFrom: '2026-10-01', validUntil: '2027-09-30', version: 3,
  updatedAt: '2026-10-01T03:00:00Z', usage: { users: 41, managementSystems: 2 },
} as const;

export const Entitlement = named(
  'Entitlement',
  z.object({
    organization: OrgSlug,
    plan: z.string().nullable(),
    source: EntitlementSource,
    ...limitsShape,
    validFrom: IsoDate,
    validUntil: IsoDate.nullable(),
    version: z.int().min(1),
    updatedAt: Instant,
    usage: z.object({ users: z.int().min(0), managementSystems: z.int().min(0) }),
  }),
  'The platform.entitlement row of an organisation with its current use (active members without guests, systems that are not archived); the ETag of the answer is the If-Match value of a change',
  {
    valid: [EXAMPLE_ENTITLEMENT, { ...EXAMPLE_ENTITLEMENT, plan: null, source: 'signed_licence', validUntil: null }],
    invalid: [{ ...EXAMPLE_ENTITLEMENT, source: 'invoice' }, { ...EXAMPLE_ENTITLEMENT, maxUsers: -1 }, { ...EXAMPLE_ENTITLEMENT, usage: undefined }],
  },
);
export type Entitlement = z.infer<typeof Entitlement>;

export const EntitlementSet = named(
  'EntitlementSet',
  z.union([
    z.strictObject({ preset: PlanPresetName, validFrom: IsoDate.optional() }),
    z.strictObject({ plan: z.string().trim().min(1).max(40).nullable().optional(), ...limitsShape, validFrom: IsoDate, validUntil: IsoDate.nullable() }),
  ]),
  'PUT /ops/organizations/{org}/entitlements body: a preset of license.plans, or explicit limits (with If-Match); a limit below current use is accepted with a warning (Milestone 2 K.6 M2-S10)',
  {
    valid: [{ preset: 'standard' }, { preset: 'trial', validFrom: '2026-11-01' }, { ...EXAMPLE_LIMITS, plan: 'custom', validFrom: '2026-10-01', validUntil: '2027-09-30' }],
    invalid: [{ preset: 'Standard' }, { ...EXAMPLE_LIMITS, validFrom: '2026-10-01' }, { preset: 'trial', maxUsers: 5 }],
  },
);
export type EntitlementSet = z.infer<typeof EntitlementSet>;

export const EntitlementSetResult = named(
  'EntitlementSetResult',
  commandResultWith(Entitlement),
  'Result of an entitlement change: the new row; warnings name a limit below current use (rule LIC-USERS or LIC-MS)',
  {
    valid: [{ ok: true, changed: [], data: EXAMPLE_ENTITLEMENT }, { ok: true, changed: [], data: EXAMPLE_ENTITLEMENT, warnings: [{ rule: 'LIC-USERS', messages: { en: '41 active members, limit 30', id: '41 anggota aktif, batas 30' } }] }],
    invalid: [{ ok: true, changed: [] }],
  },
);
export type EntitlementSetResult = z.infer<typeof EntitlementSetResult>;

export const PlanPreset = named(
  'PlanPreset',
  z.object({ name: PlanPresetName, ...limitsShape, validDays: z.int().min(1).max(3650) }),
  'A plan preset of the profile key license.plans (Milestone 2 D.3, D-S4)',
  {
    valid: [{ name: 'trial', ...EXAMPLE_LIMITS, maxUsers: 10, maxManagementSystems: 1, validDays: 30 }, { name: 'standard', ...EXAMPLE_LIMITS, validDays: 365 }],
    invalid: [{ name: 'trial', ...EXAMPLE_LIMITS, validDays: 0 }, { name: 'Trial', ...EXAMPLE_LIMITS, validDays: 30 }],
  },
);
export type PlanPreset = z.infer<typeof PlanPreset>;

const ops = { owner: 'M2-S10' as const, auth: 'session' as const, scope: 'platform' as const };

export const opsEntitlementsGetRoute = defineRoute({
  ...ops, id: 'ops.entitlements.get', method: 'GET', path: '/api/v1/ops/organizations/:org/entitlements',
  summary: 'The entitlement of an organisation with its current use; the ETag is the If-Match value of a change',
  permission: 'ops.read', params: OrgParams, response: Entitlement, errors: [404, 409],
});
export const opsEntitlementsSetRoute = defineRoute({
  ...ops, id: 'ops.entitlements.set', method: 'PUT', path: '/api/v1/ops/organizations/:org/entitlements',
  summary: 'Set the entitlement from a preset or explicit limits (If-Match; audited ops.entitlements_changed with the old and new values)',
  permission: 'ops.entitlements.manage', params: OrgParams, body: EntitlementSet, response: EntitlementSetResult,
  errors: [404, 409, 412, 422, 428], ifMatch: true,
});
export const opsPlansListRoute = defineRoute({
  ...ops, id: 'ops.plans.list', method: 'GET', path: '/api/v1/ops/plans',
  summary: 'The plan presets of license.plans', permission: 'ops.read', response: z.array(PlanPreset), errors: [409],
});

export const routes: RouteDef[] = [opsEntitlementsGetRoute, opsEntitlementsSetRoute, opsPlansListRoute];
