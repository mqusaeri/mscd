// The end of a contract in the sample service (MILESTONE-3 M3-09): the exports and the verified deletion of a sample
// organisation, shared by the operator console (ops/sample.ts) and Organisation export (org-export/sample.ts), so a
// move or an export made in one shows in the other for the browser session. A queued export is built one step per read
// (queued, then being built, then ready), as the worker would do it; the parts are small text files that stand in for
// the archive, with their real SHA-256 and a manifest, so "How to check" works in the sample build too. The purge of a
// retried deletion finishes on the next read. Nothing here runs in an api build (R-13).
import type { OrgExportDetail } from '../org-export/model';
import type { DeletionStep, DeletionView } from './lifecycle-model';
import { PURGE_STEPS } from './lifecycle-model';
import type { OrgStatus } from './org-model';

export type SampleExport = OrgExportDetail;
export type SampleDeletion = DeletionView;

/** What the lifecycle helpers read and change of a sample organisation. */
export interface LifecycleOrg {
  slug: string;
  name: string;
  status: OrgStatus;
  tenantAdmins: number;
  offboardingEndsAt: string | null;
  /** The deletion shown in the console: the one not cancelled, else the newest. */
  deletion: SampleDeletion | null;
  /** Newest first. */
  exports: SampleExport[];
}

const DAY = 864e5;
export const addDaysIso = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4) without `crypto.subtle`, which a sample build served over plain HTTP does not have
// ---------------------------------------------------------------------------------------------------------------

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** The SHA-256 of a text's UTF-8 bytes as 64 hexadecimal characters. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(total - 4, bits >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + k) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------------------------------------------
// Files of a sample export
// ---------------------------------------------------------------------------------------------------------------

/** The text of one part of a sample export. */
export function partText(org: Pick<LifecycleOrg, 'name' | 'slug'>, exportId: string, part: number, total: number): string {
  return [
    'MSCD sample build',
    `Organisation: ${org.name} (${org.slug})`,
    `Export: ${exportId}`,
    `Part ${part} of ${total}`,
    '',
    'This file stands in for one part of an organisation export. A real part is a .tar.gz archive with every table of the',
    'organisation as CSV and JSON Lines files, the audit trail with its signed anchors, and the stored files; the manifest',
    'is the last entry of the last part.',
    '',
  ].join('\n');
}

/** The manifest of a sample export: its parts with their size and SHA-256. */
export function manifestText(org: Pick<LifecycleOrg, 'name' | 'slug'>, e: Pick<SampleExport, 'id' | 'completedAt' | 'parts'>): string {
  return `${JSON.stringify({
    format: 'mscd-organization-export',
    version: 1,
    sample: true,
    organization: { slug: org.slug, name: org.name },
    exportId: e.id,
    createdAt: e.completedAt,
    parts: e.parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
  }, null, 2)}\n`;
}

/** The parts of a sample export with their real sizes and SHA-256, and its manifest's SHA-256. */
export function buildFiles(org: Pick<LifecycleOrg, 'name' | 'slug'>, e: SampleExport, partCount: number, day: string): void {
  e.parts = Array.from({ length: partCount }, (_x, i) => {
    const text = partText(org, e.id, i + 1, partCount);
    return { part: i + 1, name: `mscd-sample-export-${org.slug}-${day}-part-${i + 1}.txt`, sizeBytes: utf8Length(text), sha256: sha256Hex(text) };
  });
  e.partCount = partCount;
  e.sizeBytes = e.parts.reduce((n, p) => n + p.sizeBytes, 0);
  e.fileCount = 40 + partCount * 137;
  e.manifestSha256 = sha256Hex(manifestText(org, e));
}

/** A new export row of the sample service. */
export function newExport(values: Partial<SampleExport> & Pick<SampleExport, 'id' | 'status' | 'requestedVia' | 'requestedAt'>): SampleExport {
  return {
    requestedBy: null, decidedBy: null, decidedAt: null, decisionNote: null, isFinal: false, partCount: null, fileCount: null, sizeBytes: null,
    expiresAt: null, completedAt: null, downloadCount: 0, error: null, parts: [], manifestSha256: null, ...values,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The lifecycle of a sample organisation
// ---------------------------------------------------------------------------------------------------------------

/** The days a request waits for a decision, and a ready export stays downloadable (H.3). */
const DECISION_DAYS = 7;
export const LINK_DAYS = 7;

/** True while an export waits for approval (for at most 7 days), is queued or is being built (409 `export_in_progress`). */
export function inFlight(org: Pick<LifecycleOrg, 'exports'>, now: string): boolean {
  return org.exports.some((e) => e.status === 'queued' || e.status === 'building' || (e.status === 'requested' && Date.parse(e.requestedAt) + DECISION_DAYS * DAY > Date.parse(now)));
}

/** One step of the sample's worker and clean-up: build the oldest queued or building export, and expire what is due. */
export function advanceExports(org: LifecycleOrg, now: string): void {
  const at = Date.parse(now);
  for (const e of org.exports) {
    if (e.status === 'requested' && Date.parse(e.requestedAt) + DECISION_DAYS * DAY <= at) e.status = 'expired';
    else if (e.status === 'ready' && e.expiresAt && Date.parse(e.expiresAt) <= at) e.status = 'expired';
  }
  const working = [...org.exports].reverse().find((e) => e.status === 'queued' || e.status === 'building');
  if (!working) return;
  if (working.status === 'queued') {
    working.status = 'building';
    return;
  }
  working.status = 'ready';
  working.completedAt = now;
  working.expiresAt = working.isFinal ? null : addDaysIso(now, LINK_DAYS);
  buildFiles(org, working, working.isFinal ? 3 : 2, now.slice(0, 10));
}

/** The final export of the move to offboarding: a running export becomes the final one, else a new one is queued. */
export function queueFinalExport(org: LifecycleOrg, now: string, id: string): void {
  const running = org.exports.find((e) => e.status === 'queued' || e.status === 'building');
  if (running) {
    running.isFinal = true;
    return;
  }
  org.exports.unshift(newExport({ id, status: 'queued', requestedVia: 'offboarding', requestedAt: now, isFinal: true }));
}

/** The steps of a deletion before its purge starts. */
export const pendingSteps = (): DeletionStep[] => PURGE_STEPS.map((step) => ({ step, status: 'pending', at: null, detail: null }));

/** The checks of D.5.3 as a finished purge records them. */
export function passedChecks(org: Pick<LifecycleOrg, 'slug'>, vaultObjects: number): DeletionStep[] {
  return [
    { step: 'check: schema', status: 'done', at: null, detail: `Schema org_${org.slug} does not exist` },
    { step: 'check: platform rows', status: 'done', at: null, detail: 'No row of the organisation remains in 16 platform tables; kept by design: organization, organization_status_event, organization_deletion, organization_export, audit_log, audit_anchor' },
    { step: 'check: vault', status: 'done', at: null, detail: 'No object left under tenants/ (0 kept by a bucket retention rule)' },
    { step: 'check: data key', status: 'done', at: null, detail: 'No wrapped data key of the organisation remains, so nothing of it can be unwrapped' },
    { step: 'check: accounts', status: 'done', at: null, detail: `${Math.max(1, Math.round(vaultObjects / 100))} account(s) hold no email, name or secret` },
    { step: 'check: audit chain', status: 'done', at: null, detail: 'The platform chain verifies and its head is anchored' },
  ];
}

const STEP_DETAIL: Readonly<Record<string, (org: LifecycleOrg, vault: number) => string>> = {
  check: () => 'The deletion is due and no other purge runs',
  access: () => 'Sessions, invitations, calendar feeds and guest grants ended',
  accounts: () => 'Accounts that belonged only to this organisation were anonymised',
  vault: (_o, vault) => `${vault} objects removed`,
  database: (o) => `Schema org_${o.slug} dropped and the platform rows of the organisation deleted`,
  audit: () => 'Platform audit entries redacted under one attestation',
  organization: () => 'Status deleted',
  checks: () => '6 checks passed',
  certificate: () => 'Signed with the audit anchor key',
  emails: () => 'Certificate sent to the Tenant Admins and the platform operators',
};

/** Finishes the purge of a running deletion: every step done from the failed one, the checks, the certificate. */
export function finishPurge(org: LifecycleOrg, now: string, certificateId: string): void {
  const d = org.deletion;
  if (!d || d.status !== 'running') return;
  const vault = d.vaultObjectsDeleted ?? 846;
  d.steps = [
    ...d.steps.filter((s) => !s.step.startsWith('check: ')).map((s) => (s.status === 'done' ? s : { ...s, status: 'done' as const, at: now, detail: STEP_DETAIL[s.step]?.(org, vault) ?? null })),
    ...passedChecks(org, vault),
  ];
  d.status = 'completed';
  d.completedAt = now;
  d.failedStep = null;
  d.error = null;
  d.vaultObjectsDeleted = vault;
  d.certificateId = certificateId;
  org.status = 'deleted';
}

/** The signed certificate of a completed sample deletion, as the file the operator downloads. */
export function certificateText(org: Pick<LifecycleOrg, 'slug' | 'name'>, d: SampleDeletion): string {
  return `${JSON.stringify({
    certificate: {
      type: 'mscd-deletion-certificate-v1',
      sample: true,
      certificateId: d.certificateId,
      organization: { slug: org.slug, name: org.name },
      dates: { archivedAt: d.archivedAt, deletionScheduledFor: d.scheduledFor, deletionCompletedAt: d.completedAt },
      finalExport: d.finalExportId ? { id: d.finalExportId } : null,
      steps: d.steps.filter((s) => !s.step.startsWith('check: ')).map((s) => ({ step: s.step, status: s.status })),
      checks: d.steps.filter((s) => s.step.startsWith('check: ')).map((s) => ({ check: s.step.slice(7), passed: s.status === 'done' })),
      note: 'A certificate of the sample build. A real certificate carries an Ed25519 signature by the audit anchor key.',
    },
    keyId: 'sample',
    signature: 'sample-build-has-no-signature',
  }, null, 2)}\n`;
}

/** The read-only end, the deletion that is not cancelled and the newest export of a sample organisation (D.2). */
export function lifecycleOf(org: LifecycleOrg): {
  offboardingEndsAt: string | null;
  deletion: { status: SampleDeletion['status']; scheduledFor: string } | null;
  lastExport: { status: SampleExport['status']; readyAt: string | null } | null;
} {
  const d = org.deletion && org.deletion.status !== 'cancelled' ? org.deletion : null;
  const last = org.exports[0];
  return {
    offboardingEndsAt: org.status === 'offboarding' ? org.offboardingEndsAt : null,
    deletion: d ? { status: d.status, scheduledFor: d.scheduledFor } : null,
    lastExport: last ? { status: last.status, readyAt: last.completedAt } : null,
  };
}
