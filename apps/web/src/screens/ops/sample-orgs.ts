// Sample organisations of the operator console (MILESTONE-2 M2-S12, MILESTONE-3 M3-09): the three organisations of the
// sample snapshot and five more of the sample service only, so the sample build and its specs show every status and
// every tab of the organisation drawer: PT Mitra Logistik Andalan is suspended on a trial that ends soon with a failed
// domain, PT Sinar Farma Sejahtera is in offboarding with its plan ending and its final export ready, PT Cahaya Retail
// Nusantara is archived with its deletion scheduled, PT Delta Konstruksi Mandiri is archived with a deletion that
// failed at the vault step, and PT Karya Tekstil Prima is deleted with its certificate. PT Nusantara Digital Teknologi
// has an export waiting for approval, a ready one, a rejected one and an expired one. Dates are relative to the
// sample's today (2026-09-29). The organisations, their exports and their deletions are one store of the browser
// session (`sampleServiceOrgs`), which the operator console and Organisation export share.
import type { ControllerData } from '../../data/types';
import type { Domain, EntitlementSource, Limits, OrgStatus, PlanPreset, StatusEvent } from './org-model';
import { buildFiles, newExport, passedChecks, pendingSteps } from './sample-lifecycle';
import type { LifecycleOrg, SampleDeletion, SampleExport } from './sample-lifecycle';

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

export interface SampleOrg extends LifecycleOrg {
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
const RINA = { handle: 'rina', displayName: 'Rina Kusuma' };
const TONO = { handle: 'tono', displayName: 'Tono Hartono' };

function entitlement(values: Partial<SampleEntitlement> & Pick<SampleEntitlement, 'plan' | 'source' | 'maxUsers' | 'maxManagementSystems' | 'validFrom' | 'validUntil'>): SampleEntitlement {
  return {
    frameworks: [], storageAdapters: [...ADAPTERS], features: [...ALL_FEATURES], rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30,
    version: 1, updatedAt: `${values.validFrom}T03:00:00.000Z`, ...values,
  };
}

const txt = (domain: string) => `_mscd-verify.${domain}`;
const exportId = (n: string) => `5a6b7c8d-9e0f-4a1b-8c2d-0000000e${n}`;
const deletionId = (n: string) => `1e2f3a4b-5c6d-4e7f-8a9b-0000000d${n}`;

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
    offboardingEndsAt: null,
    deletion: null,
    exports: [
      newExport({ id: exportId('0004'), status: 'requested', requestedVia: 'tenant_admin', requestedBy: TONO, requestedAt: '2026-09-28T02:00:00Z' }),
      newExport({
        id: exportId('0003'), status: 'ready', requestedVia: 'tenant_admin', requestedBy: RINA, requestedAt: '2026-09-26T02:30:00Z', decidedBy: TONO,
        decidedAt: '2026-09-26T03:00:00Z', completedAt: '2026-09-26T03:40:00Z', expiresAt: '2026-10-03T03:40:00Z', downloadCount: 1, partCount: 2,
      }),
      newExport({
        id: exportId('0002'), status: 'rejected', requestedVia: 'tenant_admin', requestedBy: RINA, requestedAt: '2026-09-10T04:00:00Z', decidedBy: TONO,
        decidedAt: '2026-09-10T06:00:00Z', decisionNote: 'Not before the surveillance audit; ask again in October.',
      }),
      newExport({
        id: exportId('0001'), status: 'expired', requestedVia: 'operator', requestedAt: '2026-08-01T02:00:00Z', completedAt: '2026-08-01T03:00:00Z',
        expiresAt: '2026-08-08T03:00:00Z', downloadCount: 2, partCount: 2,
      }),
    ],
  },
  bsd: {
    status: 'active', region: 'id', createdAt: '2026-02-15T03:00:00Z', memberCount: 41, tenantAdmins: 1, lastSignInAt: '2026-09-28T08:40:00Z',
    entitlement: entitlement({ plan: null, source: 'signed_licence', maxUsers: 50, maxManagementSystems: 2, validFrom: '2025-09-16', validUntil: '2026-09-15', frameworks: ['ISO27001', 'ISO9001'] }),
    domains: [
      { domain: 'banksentosa.co.id', status: 'verified', method: 'manual', requestedAt: null, verifiedAt: '2026-02-16T03:00:00Z', lastCheckedAt: null, pendingUntil: null, txtName: txt('banksentosa.co.id'), checks: 0 },
    ],
    events: [],
    offboardingEndsAt: null,
    deletion: null,
    exports: [],
  },
  rmn: {
    status: 'active', region: 'id', createdAt: '2026-01-31T03:00:00Z', memberCount: 23, tenantAdmins: 1, lastSignInAt: '2026-09-27T06:05:00Z',
    entitlement: entitlement({ plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validFrom: '2026-02-01', validUntil: '2027-01-31' }),
    domains: [],
    events: [],
    offboardingEndsAt: null,
    deletion: null,
    exports: [],
  },
};

/** The steps of the failed purge of PT Delta Konstruksi Mandiri: the first three done, the vault step failed. */
function failedSteps(): SampleDeletion['steps'] {
  const at = (minute: number) => `2026-09-24T03:${String(20 + minute).padStart(2, '0')}:00Z`;
  return pendingSteps().map((s, i) => {
    if (i < 3) return { ...s, status: 'done' as const, at: at(i), detail: ['The deletion is due and no other purge runs', 'Sessions, invitations, calendar feeds and guest grants ended', '14 accounts anonymised, 3 kept for their other organisations'][i] };
    if (s.step === 'vault') return { ...s, status: 'failed' as const, at: at(3), detail: 'The storage gateway did not answer: connect ECONNREFUSED 10.0.4.12:8443' };
    return s;
  });
}

/** The steps of the completed purge of PT Karya Tekstil Prima, with its checks. */
function completedSteps(): SampleDeletion['steps'] {
  const details = [
    'The deletion is due and no other purge runs', 'Sessions, invitations, calendar feeds and guest grants ended', '19 accounts anonymised, 2 kept for their other organisations',
    '1284 objects, 1301 versions removed', 'Schema org_karya_tekstil dropped and the platform rows of the organisation deleted', 'Platform audit entries redacted under one attestation',
    'Status deleted', '6 checks passed', 'Signed with the audit anchor key', 'Certificate sent to 2 Tenant Admins and 3 platform operators',
  ];
  return [
    ...pendingSteps().map((s, i) => ({ ...s, status: 'done' as const, at: `2026-08-14T03:${String(i * 2 + 1).padStart(2, '0')}:00Z`, detail: details[i] })),
    ...passedChecks({ slug: 'karya_tekstil' }, 1284),
  ];
}

/** The five organisations of the sample service that are not in the snapshot. */
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
    offboardingEndsAt: null,
    deletion: null,
    exports: [],
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
    offboardingEndsAt: '2026-10-19T03:00:00Z',
    deletion: null,
    exports: [
      newExport({
        id: exportId('0f01'), status: 'ready', requestedVia: 'offboarding', requestedAt: '2026-09-19T03:00:00Z', isFinal: true, completedAt: '2026-09-19T04:10:00Z',
        partCount: 3,
      }),
    ],
  },
  {
    slug: 'cahaya_retail', name: 'PT Cahaya Retail Nusantara', status: 'archived', region: 'id', createdAt: '2025-06-01T03:00:00Z',
    memberCount: 22, systemCount: 1, tenantAdmins: 1, lastSignInAt: '2026-09-18T07:45:00Z',
    entitlement: entitlement({ plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validFrom: '2025-08-21', validUntil: '2026-08-20' }),
    domains: [
      { domain: 'cahayaretail.co.id', status: 'verified', method: 'dns', requestedAt: '2025-06-01T03:00:00Z', verifiedAt: '2025-06-01T05:35:00Z', lastCheckedAt: '2026-08-20T05:35:00Z', pendingUntil: null, txtName: txt('cahayaretail.co.id'), checks: 21 },
    ],
    events: [
      { id: 'ev-crn-2', from: 'offboarding', to: 'archived', reason: 'The read-only period ended on 2026-09-20', actor: null, at: '2026-09-20T03:00:00Z' },
      { id: 'ev-crn-1', from: 'active', to: 'offboarding', reason: 'Contract ended on 20 August 2026 and was not renewed', actor: OWNER, at: '2026-08-21T03:00:00Z' },
    ],
    offboardingEndsAt: null,
    deletion: {
      id: deletionId('0c01'), status: 'scheduled', scheduledFor: '2026-10-20T03:00:00Z', scheduledBy: null, reason: 'The read-only period ended on 2026-09-20',
      archivedAt: '2026-09-20T03:00:00Z', earliestAllowed: '2026-09-27T03:00:00Z', finalExportId: exportId('0c01'), startedAt: null, completedAt: null, failedStep: null,
      error: null, steps: [], vaultObjectsDeleted: null, certificateId: null,
    },
    exports: [
      newExport({
        id: exportId('0c01'), status: 'expired', requestedVia: 'offboarding', requestedAt: '2026-08-21T03:00:00Z', isFinal: true, completedAt: '2026-08-21T03:50:00Z',
        downloadCount: 3, partCount: 3,
      }),
    ],
  },
  {
    slug: 'delta_konstruksi', name: 'PT Delta Konstruksi Mandiri', status: 'archived', region: 'id', createdAt: '2025-03-01T03:00:00Z',
    memberCount: 17, systemCount: 2, tenantAdmins: 1, lastSignInAt: '2026-08-22T02:15:00Z',
    entitlement: entitlement({ plan: 'standard', source: 'preset', maxUsers: 50, maxManagementSystems: 3, validFrom: '2025-07-26', validUntil: '2026-07-25' }),
    domains: [],
    events: [
      { id: 'ev-dkm-2', from: 'offboarding', to: 'archived', reason: 'The read-only period ended on 2026-08-25', actor: null, at: '2026-08-25T03:00:00Z' },
      { id: 'ev-dkm-1', from: 'active', to: 'offboarding', reason: 'Contract ended on 25 July 2026', actor: OWNER, at: '2026-07-26T03:00:00Z' },
    ],
    offboardingEndsAt: null,
    deletion: {
      id: deletionId('0d01'), status: 'failed', scheduledFor: '2026-09-24T03:00:00Z', scheduledBy: null, reason: 'The read-only period ended on 2026-08-25',
      archivedAt: '2026-08-25T03:00:00Z', earliestAllowed: '2026-09-01T03:00:00Z', finalExportId: exportId('0d01'), startedAt: '2026-09-24T03:20:00Z', completedAt: null,
      failedStep: 'vault', error: 'The storage gateway did not answer: connect ECONNREFUSED 10.0.4.12:8443', steps: failedSteps(), vaultObjectsDeleted: null,
      certificateId: null,
    },
    exports: [
      newExport({
        id: exportId('0d01'), status: 'expired', requestedVia: 'offboarding', requestedAt: '2026-07-26T03:00:00Z', isFinal: true, completedAt: '2026-07-26T03:30:00Z',
        downloadCount: 1, partCount: 2,
      }),
    ],
  },
  {
    slug: 'karya_tekstil', name: 'PT Karya Tekstil Prima', status: 'deleted', region: 'id', createdAt: '2024-11-01T03:00:00Z',
    memberCount: 0, systemCount: 0, tenantAdmins: 0, lastSignInAt: null,
    entitlement: null,
    domains: [],
    events: [
      { id: 'ev-ktp-3', from: 'archived', to: 'deleted', reason: 'Deleted on its deletion date', actor: null, at: '2026-08-14T03:19:00Z' },
      { id: 'ev-ktp-2', from: 'offboarding', to: 'archived', reason: 'The read-only period ended on 2026-07-15', actor: null, at: '2026-07-15T03:00:00Z' },
      { id: 'ev-ktp-1', from: 'active', to: 'offboarding', reason: 'Contract ended on 15 June 2026', actor: OWNER, at: '2026-06-15T03:00:00Z' },
    ],
    offboardingEndsAt: null,
    deletion: {
      id: deletionId('0e01'), status: 'completed', scheduledFor: '2026-08-14T03:00:00Z', scheduledBy: null, reason: 'The read-only period ended on 2026-07-15',
      archivedAt: '2026-07-15T03:00:00Z', earliestAllowed: '2026-07-22T03:00:00Z', finalExportId: exportId('0e01'), startedAt: '2026-08-14T03:00:00Z',
      completedAt: '2026-08-14T03:19:00Z', failedStep: null, error: null, steps: completedSteps(), vaultObjectsDeleted: 1284,
      certificateId: '2f3a4b5c-6d7e-4f8a-9b0c-00000000ce01',
    },
    exports: [
      newExport({
        id: exportId('0e01'), status: 'expired', requestedVia: 'offboarding', requestedAt: '2026-06-15T03:00:00Z', isFinal: true, completedAt: '2026-06-15T04:05:00Z',
        downloadCount: 2, partCount: 3,
      }),
    ],
  },
];

/** A deep copy of a sample organisation (the module keeps the originals), with the files of its built exports. */
export function cloneOrg(org: SampleOrg): SampleOrg {
  const copy: SampleOrg = {
    ...org,
    entitlement: org.entitlement ? { ...org.entitlement, frameworks: [...org.entitlement.frameworks], storageAdapters: [...org.entitlement.storageAdapters], features: [...org.entitlement.features] } : null,
    domains: org.domains.map((d) => ({ ...d })),
    events: org.events.map((e) => ({ ...e, actor: e.actor ? { ...e.actor } : null })),
    deletion: org.deletion ? { ...org.deletion, scheduledBy: org.deletion.scheduledBy ? { ...org.deletion.scheduledBy } : null, steps: org.deletion.steps.map((s) => ({ ...s })) } : null,
    exports: org.exports.map((e): SampleExport => ({ ...e, requestedBy: e.requestedBy ? { ...e.requestedBy } : null, decidedBy: e.decidedBy ? { ...e.decidedBy } : null, parts: e.parts.map((p) => ({ ...p })) })),
  };
  for (const e of copy.exports) {
    if ((e.status === 'ready' || e.status === 'expired') && e.completedAt && !e.parts.length) buildFiles(copy, e, e.partCount ?? 2, e.completedAt.slice(0, 10));
  }
  return copy;
}

/** A sample organisation of the snapshot (one the sample does not describe is a small active organisation without a plan). */
export function snapshotOrg(slug: string, name: string, systemCount: number, index: number): SampleOrg {
  const known = KNOWN[slug] ?? {
    status: 'active' as const, region: 'id', createdAt: `2026-0${(index % 9) + 1}-15T03:00:00Z`, memberCount: 10, tenantAdmins: 1, lastSignInAt: null,
    entitlement: null, domains: [], events: [], offboardingEndsAt: null, deletion: null, exports: [],
  };
  return cloneOrg({ ...known, slug, name, systemCount });
}

/** Free mail domains that anyone can use (a part of the server's list, M2-S11). */
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.id', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'ymail.com']);

// ---------------------------------------------------------------------------------------------------------------
// The organisations of the sample service, one store for the browser session
// ---------------------------------------------------------------------------------------------------------------

let orgs: SampleOrg[] | null = null;

/** The organisations of the sample service: those of the snapshot, then the five of the sample service only. */
export function sampleServiceOrgs(D: ControllerData | null): SampleOrg[] {
  orgs ??= [
    ...(D?.orgs ?? []).map((o, i) => snapshotOrg(o.id, o.name, o.ms.length, i)),
    ...EXTRA_ORGS.filter((x) => !(D?.orgs ?? []).some((o) => o.id === x.slug)).map(cloneOrg),
  ];
  return orgs;
}

/** Forgets the changes of the session (unit tests). */
export function resetSampleService(): void {
  orgs = null;
}

/** Now on the sample's day: the sample's today at the current local time, so new records sit beside the sample's. */
export function sampleNow(day: string | null): string {
  const now = new Date();
  if (!day) return now.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = new Date(`${day}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  return Number.isNaN(local.getTime()) ? now.toISOString() : new Date(local.getTime() + now.getMilliseconds()).toISOString();
}

/** A new id in the shape of a uuid. */
export function sampleId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}
