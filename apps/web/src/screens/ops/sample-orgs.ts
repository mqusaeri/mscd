// Sample organisations of the operator console (MILESTONE-2 M2-S12): the three organisations of the sample snapshot
// and two more of the sample service only, so the sample build and its specs show every status and every tab of the
// organisation drawer: PT Mitra Logistik Andalan is suspended on a trial that ends soon with a failed domain, PT Sinar
// Farma Sejahtera is in offboarding with its plan ending. Dates are relative to the sample's today (2026-09-29).
import type { Domain, EntitlementSource, Limits, OrgStatus, PlanPreset, StatusEvent } from './org-model';

/** The entitlement row of a sample organisation. */
export interface SampleEntitlement extends Limits {
  plan: string | null;
  source: EntitlementSource;
  validFrom: string;
  validUntil: string | null;
  version: number;
  updatedAt: string;
}

/** A domain of a sample organisation; `checks` counts the lookups so far (from the second one the record is found). */
export interface SampleDomain extends Domain {
  checks: number;
}

export interface SampleOrg {
  slug: string;
  name: string;
  status: OrgStatus;
  region: string | null;
  createdAt: string;
  memberCount: number;
  systemCount: number;
  tenantAdmins: number;
  entitlement: SampleEntitlement | null;
  domains: SampleDomain[];
  /** Newest first. */
  events: StatusEvent[];
  lastSignInAt: string | null;
}

const ALL_FEATURES: Limits['features'] = ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'];
const ADAPTERS: Limits['storageAdapters'] = ['managed_vault', 'm365', 'google_drive'];

/** The D-S4 presets of `license.plans` (saas.yaml). */
export const SAMPLE_PRESETS: readonly PlanPreset[] = [
  { name: 'trial', maxUsers: 10, maxManagementSystems: 1, frameworks: [], storageAdapters: ADAPTERS, features: ALL_FEATURES, rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 7, validDays: 30 },
  { name: 'standard', maxUsers: 50, maxManagementSystems: 3, frameworks: [], storageAdapters: ADAPTERS, features: ALL_FEATURES, rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30, validDays: 365 },
];

const OWNER = { handle: 'ops.owner', displayName: 'Platform owner' };

function entitlement(values: Partial<SampleEntitlement> & Pick<SampleEntitlement, 'plan' | 'source' | 'maxUsers' | 'maxManagementSystems' | 'validFrom' | 'validUntil'>): SampleEntitlement {
  return {
    frameworks: [], storageAdapters: [...ADAPTERS], features: [...ALL_FEATURES], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30,
    version: 1, updatedAt: `${values.validFrom}T03:00:00.000Z`, ...values,
  };
}

const txt = (domain: string) => `_mscd-verify.${domain}`;

/** Lifecycle data of the snapshot's organisations, by slug. */
const KNOWN: Record<string, Omit<SampleOrg, 'slug' | 'name' | 'systemCount'>> = {
  ndt: {
    status: 'active', region: 'id', createdAt: '2026-01-15T03:00:00Z', memberCount: 86, tenantAdmins: 2, lastSignInAt: '2026-09-29T01:12:00Z',
    entitlement: entitlement({ plan: 'enterprise', source: 'manual', maxUsers: 100, maxManagementSystems: 5, validFrom: '2026-04-01', validUntil: '2027-03-31', version: 3, updatedAt: '2026-04-01T03:00:00.000Z' }),
    domains: [
      { domain: 'nusantaradigital.co.id', status: 'verified', method: 'dns', requestedAt: '2026-01-16T03:00:00Z', verifiedAt: '2026-01-16T04:35:00Z', lastCheckedAt: '2026-09-16T04:35:00Z', pendingUntil: null, txtName: txt('nusantaradigital.co.id'), checks: 9 },
      { domain: 'ndt.co.id', status: 'pending', method: 'dns', requestedAt: '2026-09-27T02:00:00Z', verifiedAt: null, lastCheckedAt: '2026-09-28T23:35:00Z', pendingUntil: '2026-10-04T02:00:00Z', txtName: txt('ndt.co.id'), checks: 1 },
    ],
    events: [
      { id: 'ev-ndt-2', from: 'suspended', to: 'active', reason: 'Invoice of April paid', actor: OWNER, at: '2026-05-09T02:30:00Z' },
      { id: 'ev-ndt-1', from: 'active', to: 'suspended', reason: 'Invoice of April unpaid after two reminders', actor: OWNER, at: '2026-05-02T02:00:00Z' },
    ],
  },
  bsd: {
    status: 'active', region: 'id', createdAt: '2026-02-15T03:00:00Z', memberCount: 41, tenantAdmins: 1, lastSignInAt: '2026-09-28T08:40:00Z',
    entitlement: entitlement({ plan: null, source: 'signed_licence', maxUsers: 50, maxManagementSystems: 2, validFrom: '2025-09-16', validUntil: '2026-09-15', frameworks: ['ISO27001', 'ISO9001'] }),
    domains: [
      { domain: 'banksentosa.co.id', status: 'verified', method: 'manual', requestedAt: null, verifiedAt: '2026-02-16T03:00:00Z', lastCheckedAt: null, pendingUntil: null, txtName: txt('banksentosa.co.id'), checks: 0 },
    ],
    events: [],
  },
  rmn: {
    status: 'active', region: 'id', createdAt: '2026-01-31T03:00:00Z', memberCount: 23, tenantAdmins: 1, lastSignInAt: '2026-09-27T06:05:00Z',
    entitlement: entitlement({ plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validFrom: '2026-02-01', validUntil: '2027-01-31' }),
    domains: [],
    events: [],
  },
};

/** The two organisations of the sample service that are not in the snapshot. */
export const EXTRA_ORGS: readonly SampleOrg[] = [
  {
    slug: 'mitra_logistik', name: 'PT Mitra Logistik Andalan', status: 'suspended', region: 'id', createdAt: '2026-09-12T03:00:00Z',
    memberCount: 8, systemCount: 1, tenantAdmins: 1, lastSignInAt: '2026-09-25T09:20:00Z',
    entitlement: entitlement({ plan: 'trial', source: 'preset', maxUsers: 10, maxManagementSystems: 1, validFrom: '2026-09-12', validUntil: '2026-10-11', graceDays: 7 }),
    domains: [
      { domain: 'mitralogistik.co.id', status: 'failed', method: 'dns', requestedAt: '2026-09-12T03:00:00Z', verifiedAt: null, lastCheckedAt: '2026-09-19T03:35:00Z', pendingUntil: null, txtName: txt('mitralogistik.co.id'), checks: 168 },
    ],
    events: [
      { id: 'ev-mla-1', from: 'active', to: 'suspended', reason: 'Trial paused at the customer\'s request until the purchase order is signed', actor: OWNER, at: '2026-09-26T02:00:00Z' },
    ],
  },
  {
    slug: 'sinar_farma', name: 'PT Sinar Farma Sejahtera', status: 'offboarding', region: 'id', createdAt: '2025-10-01T03:00:00Z',
    memberCount: 15, systemCount: 2, tenantAdmins: 1, lastSignInAt: '2026-09-24T03:10:00Z',
    entitlement: entitlement({ plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validFrom: '2025-10-01', validUntil: '2026-09-30' }),
    domains: [
      { domain: 'sinarfarma.co.id', status: 'verified', method: 'dns', requestedAt: '2025-10-01T03:00:00Z', verifiedAt: '2025-10-01T05:35:00Z', lastCheckedAt: '2026-09-01T05:35:00Z', pendingUntil: null, txtName: txt('sinarfarma.co.id'), checks: 13 },
    ],
    events: [
      { id: 'ev-sfs-1', from: 'active', to: 'offboarding', reason: 'Contract ends on 30 September 2026 and was not renewed', actor: OWNER, at: '2026-09-19T03:00:00Z' },
    ],
  },
];

/** A deep copy of a sample organisation (the module keeps the originals). */
export function cloneOrg(org: SampleOrg): SampleOrg {
  return {
    ...org,
    entitlement: org.entitlement ? { ...org.entitlement, frameworks: [...org.entitlement.frameworks], storageAdapters: [...org.entitlement.storageAdapters], features: [...org.entitlement.features] } : null,
    domains: org.domains.map((d) => ({ ...d })),
    events: org.events.map((e) => ({ ...e, actor: e.actor ? { ...e.actor } : null })),
  };
}

/** A sample organisation of the snapshot (one the sample does not describe is a small active organisation without a plan). */
export function snapshotOrg(slug: string, name: string, systemCount: number, index: number): SampleOrg {
  const known = KNOWN[slug] ?? {
    status: 'active' as const, region: 'id', createdAt: `2026-0${(index % 9) + 1}-15T03:00:00Z`, memberCount: 10, tenantAdmins: 1, lastSignInAt: null,
    entitlement: null, domains: [], events: [],
  };
  return cloneOrg({ ...known, slug, name, systemCount });
}

/** Free mail domains that anyone can use (a part of the server's list, M2-S11). */
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.id', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'ymail.com']);
