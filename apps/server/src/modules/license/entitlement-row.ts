// The `platform.entitlement` row of an organisation (Milestone 2 D.3, K.6 M2-S10): in multi tenancy the effective
// licence of the organisation. This file holds the row type, its read and the conversions; the writes are in
// entitlement-store.ts (platform scope only, audited, with the change notice) and the cache in entitlement-registry.ts.
import {
  LICENCE_FEATURES,
  STORAGE_ADAPTERS,
  type Entitlement,
  type EntitlementSource,
  type LicenceDocument,
  type LicenceFeature,
  type PlanPreset,
  type StorageAdapter,
} from '@mscd/shared';
import { addDays } from '../../common/dates';
import type { Trx } from '../../common/tokens';
import type { Profile } from '../../config/profile.schema';

/** One `platform.entitlement` row. */
export interface EntitlementRecord {
  organizationId: string;
  /** The preset of `license.plans` the limits came from; null for limits set by hand or from a signed licence. */
  plan: string | null;
  source: EntitlementSource;
  /** Active members without guests (product decision 5). */
  maxUsers: number;
  /** Systems that are not archived. */
  maxManagementSystems: number;
  /** Framework codes; empty means every framework unless the row comes from a signed licence (`allFrameworks`). */
  frameworks: string[];
  storageAdapters: StorageAdapter[];
  features: LicenceFeature[];
  /** Requests per user and minute; null uses `DEFAULT_RATE_LIMITS`. */
  rateUserPerMinute: number | null;
  /** Requests per organisation and minute; null uses `DEFAULT_RATE_LIMITS`. */
  rateOrgPerMinute: number | null;
  validFrom: string;
  /** Last valid day; null: no end date. */
  validUntil: string | null;
  graceDays: number;
  version: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/** The values a write sets (the rest is kept by the table: version, time, author). */
export type EntitlementValues = Omit<EntitlementRecord, 'organizationId' | 'version' | 'updatedAt' | 'updatedBy'>;

/** The limits a preset of `license.plans` gives (profile key, Milestone 2 D.3, D-S4). */
export type PlanPresetConfig = Profile['license']['plans'][string];

/**
 * The `valid_until` of the licence document an entitlement without an end date is evaluated as (D-15 needs one):
 * the last day the date type of the shared contract holds.
 */
export const NO_END_DATE = '9999-12-31';

const ADAPTERS: ReadonlySet<string> = new Set(STORAGE_ADAPTERS);
const FEATURES: ReadonlySet<string> = new Set(LICENCE_FEATURES);

interface EntitlementDbRow {
  organization_id: string;
  plan: string | null;
  source: EntitlementSource;
  max_users: number;
  max_management_systems: number;
  frameworks: string[];
  storage_adapters: string[];
  features: string[];
  rate_user_per_minute: number | null;
  rate_org_per_minute: number | null;
  valid_from: string;
  valid_until: string | null;
  grace_days: number;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

export const ENTITLEMENT_COLUMNS = [
  'organization_id',
  'plan',
  'source',
  'max_users',
  'max_management_systems',
  'frameworks',
  'storage_adapters',
  'features',
  'rate_user_per_minute',
  'rate_org_per_minute',
  'valid_from',
  'valid_until',
  'grace_days',
  'version',
  'updated_at',
  'updated_by',
] as const;

/** A database row as a record (adapters and features the build does not know are left out). */
export function recordOf(row: EntitlementDbRow): EntitlementRecord {
  return {
    organizationId: row.organization_id,
    plan: row.plan,
    source: row.source,
    maxUsers: row.max_users,
    maxManagementSystems: row.max_management_systems,
    frameworks: [...row.frameworks],
    storageAdapters: row.storage_adapters.filter((a): a is StorageAdapter => ADAPTERS.has(a)),
    features: row.features.filter((f): f is LicenceFeature => FEATURES.has(f)),
    rateUserPerMinute: row.rate_user_per_minute,
    rateOrgPerMinute: row.rate_org_per_minute,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    graceDays: row.grace_days,
    version: row.version,
    updatedAt: new Date(row.updated_at),
    updatedBy: row.updated_by,
  };
}

/**
 * The entitlement row of an organisation in the caller's transaction. RLS: an organisation-scoped transaction sees
 * its own row only, platform scope every row (D.3, F.10).
 */
export async function readEntitlement(trx: Trx, orgId: string, options: { forUpdate?: boolean } = {}): Promise<EntitlementRecord | null> {
  let query = trx.selectFrom('platform.entitlement').select([...ENTITLEMENT_COLUMNS]).where('organization_id', '=', orgId);
  if (options.forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row ? recordOf(row as EntitlementDbRow) : null;
}

/** The ETag of an entitlement version: `W/"<version>-<updated_at in epoch milliseconds>"`. */
export function entitlementEtag(row: Pick<EntitlementRecord, 'version' | 'updatedAt'>): string {
  return `W/"${row.version}-${row.updatedAt.getTime()}"`;
}

/** Opaque part of an entity tag (`W/"x"` and `"x"` give `x`). */
function opaque(tag: string): string {
  const trimmed = tag.trim().replace(/^W\//, '');
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The `If-Match` check of a change (D.1 Concurrency, Milestone 2 D.1 `ops.entitlements.set`): `missing` without the
 * header (428), `ok` for `*` or the current ETag, `stale` otherwise. An organisation without a row accepts `*` only.
 */
export function ifMatchOf(header: string | undefined, row: EntitlementRecord | null): 'missing' | 'ok' | 'stale' {
  if (header === undefined || header.trim() === '') return 'missing';
  if (header.trim() === '*') return 'ok';
  if (!row) return 'stale';
  const current = opaque(entitlementEtag(row));
  return header.split(',').some((tag) => opaque(tag) === current) ? 'ok' : 'stale';
}

/** True when two value sets are the same, lists compared as sets (a write that changes nothing is skipped). */
export function sameValues(a: EntitlementValues, b: EntitlementValues): boolean {
  const list = (x: readonly string[]) => [...new Set(x)].sort().join(',');
  return (
    a.plan === b.plan &&
    a.source === b.source &&
    a.maxUsers === b.maxUsers &&
    a.maxManagementSystems === b.maxManagementSystems &&
    list(a.frameworks) === list(b.frameworks) &&
    list(a.storageAdapters) === list(b.storageAdapters) &&
    list(a.features) === list(b.features) &&
    a.rateUserPerMinute === b.rateUserPerMinute &&
    a.rateOrgPerMinute === b.rateOrgPerMinute &&
    a.validFrom === b.validFrom &&
    a.validUntil === b.validUntil &&
    a.graceDays === b.graceDays
  );
}

/** The values of a record. */
export function valuesOf(row: EntitlementRecord): EntitlementValues {
  return {
    plan: row.plan,
    source: row.source,
    maxUsers: row.maxUsers,
    maxManagementSystems: row.maxManagementSystems,
    frameworks: [...row.frameworks],
    storageAdapters: [...row.storageAdapters],
    features: [...row.features],
    rateUserPerMinute: row.rateUserPerMinute,
    rateOrgPerMinute: row.rateOrgPerMinute,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    graceDays: row.graceDays,
  };
}

/** The audit form of values (`ops.entitlements_changed` before and after). */
export function auditValues(values: EntitlementValues | null): Record<string, unknown> | null {
  if (!values) return null;
  return { ...values, frameworks: [...values.frameworks].sort(), storageAdapters: [...values.storageAdapters].sort(), features: [...values.features].sort() };
}

/** The values of a preset of `license.plans` starting on `validFrom`: valid for `valid_days` days, both ends included. */
export function presetValues(name: string, preset: PlanPresetConfig, validFrom: string): EntitlementValues {
  return {
    plan: name,
    source: 'preset',
    maxUsers: preset.max_users,
    maxManagementSystems: preset.max_management_systems,
    frameworks: [...preset.frameworks],
    storageAdapters: [...preset.storage_adapters],
    features: [...preset.features],
    rateUserPerMinute: preset.rate_user_per_minute,
    rateOrgPerMinute: preset.rate_org_per_minute,
    validFrom,
    validUntil: addDays(validFrom, preset.valid_days - 1),
    graceDays: preset.grace_days,
  };
}

/** The values of a verified signed licence (source `signed_licence`); rate limits are not part of a licence. */
export function licenceValues(document: LicenceDocument, rates: Pick<EntitlementValues, 'rateUserPerMinute' | 'rateOrgPerMinute'> = { rateUserPerMinute: null, rateOrgPerMinute: null }): EntitlementValues {
  return {
    plan: null,
    source: 'signed_licence',
    maxUsers: document.max_users,
    maxManagementSystems: document.max_management_systems,
    frameworks: [...document.frameworks],
    storageAdapters: [...document.storage_adapters],
    features: document.features.filter((f): f is LicenceFeature => FEATURES.has(f)),
    rateUserPerMinute: rates.rateUserPerMinute,
    rateOrgPerMinute: rates.rateOrgPerMinute,
    validFrom: document.valid_from,
    validUntil: document.valid_until,
    graceDays: document.grace_days,
  };
}

/** True when an empty framework list means every framework (presets and limits set by the operator). */
export function allFrameworks(row: Pick<EntitlementRecord, 'source' | 'frameworks'>): boolean {
  return row.frameworks.length === 0 && row.source !== 'signed_licence';
}

/** The plan presets of the profile, sorted by name (`ops.plans.list`). */
export function planPresets(plans: Profile['license']['plans']): PlanPreset[] {
  return Object.keys(plans)
    .sort()
    .map((name) => {
      const p = plans[name]!;
      return {
        name,
        maxUsers: p.max_users,
        maxManagementSystems: p.max_management_systems,
        frameworks: [...p.frameworks],
        storageAdapters: [...p.storage_adapters],
        features: [...p.features],
        rateUserPerMinute: p.rate_user_per_minute,
        rateOrgPerMinute: p.rate_org_per_minute,
        graceDays: p.grace_days,
        validDays: p.valid_days,
      };
    });
}

/** The `Entitlement` of the api (`ops.entitlements.get`, `ops.entitlements.set`). */
export function entitlementView(row: EntitlementRecord, slug: string, usage: { users: number; managementSystems: number }): Entitlement {
  return {
    organization: slug,
    plan: row.plan,
    source: row.source,
    maxUsers: row.maxUsers,
    maxManagementSystems: row.maxManagementSystems,
    frameworks: [...row.frameworks],
    storageAdapters: [...row.storageAdapters],
    features: [...row.features],
    rateUserPerMinute: row.rateUserPerMinute,
    rateOrgPerMinute: row.rateOrgPerMinute,
    graceDays: row.graceDays,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    usage,
  };
}
