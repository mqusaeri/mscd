// Sample adapter of the operator console: a healthy installation, the queues of a quiet afternoon, the organisations of
// the sample service (the three of the snapshot and five more, sample-orgs.ts) with their status, plan, domains,
// history, exports and deletion, the D-S4 plan presets, the packs of the sample (ISO 9001 and ISO 37001 in their newer
// editions), and the accounts and platform operators of the sample service (sample-accounts.ts, M2-19). Created
// organisations, status changes, domains, entitlements, licences, packs, exports and deletions stay for the browser
// session; an imported bundle shows as "Installing" on the next read and as installed on the one after, as the worker
// would do it, and an export is built the same way (sample-lifecycle.ts). The moves follow Milestone 3 J.8: offboarding
// sets the end of the read-only period and queues the final export, archiving schedules the deletion, and an archived
// organisation reopens for export only while its deletion is scheduled. The state belongs to the installation (the
// operator sees every organisation), so it is not kept per organisation.
import type { ControllerData } from '../../data/types';
import { textFile } from '../auditor-access/shared';
import { EXPORTABLE } from './lifecycle-model';
import type { DeletionView, OpsExport } from './lifecycle-model';
import type { Health, LicenceState, OpsAdapter, OrgItem, PackItem, Result } from './model';
import { DELETION_GRACE_DAYS, NO_END, READ_ONLY_DAYS, REOPEN_DAYS, STATUS_MOVES, daysBetween, entitlementEtag, localIso, needsSlug, presetUntil } from './org-model';
import type { Domain, Entitlement, EntitlementInput, OrgDetail, OrgStatus } from './org-model';
import { resetSampleAccounts, sampleAccounts } from './sample-accounts';
import {
  addDaysIso, advanceExports, certificateText, finishPurge, inFlight, lifecycleOf, newExport, pendingSteps, queueFinalExport,
} from './sample-lifecycle';
import { FREE_MAIL, SAMPLE_PRESETS, resetSampleService, sampleId, sampleNow, sampleServiceOrgs } from './sample-orgs';
import type { SampleEntitlement, SampleOrg } from './sample-orgs';

const NO_SERVER: [string, string] = ['The sample build has no server to read diagnostics from.', 'Versi contoh tidak memiliki server untuk membaca diagnostik.'];

type Extra = { messageKey?: string; rule?: string; slug?: string; errors?: { path: string; message: string }[] };
const refuse = <T,>(status: number, message: readonly [string, string], extra: Extra = {}): Result<T> => ({
  ok: false,
  error: { status, message: [message[0], message[1]], ...extra },
});
/** A refusal whose server answer carries only the problem title (no `messages`). */
const titled = <T,>(status: number, title: string, extra: Extra = {}): Result<T> => refuse<T>(status, [title, title], extra);

interface State {
  packs: PackItem[];
  /** Imported packs still installing: the number of reads left until they are installed. */
  installing: Map<string, number>;
}
let state: State | null = null;

/** Forgets the changes of the session (unit tests). */
export function resetSampleOps(): void {
  state = null;
  resetSampleAccounts();
  resetSampleService();
}

function initialPacks(): PackItem[] {
  return [
    { packId: 'ISO27001-2022', version: '1.2.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false, installedAt: '2026-02-02T03:00:00Z' },
    { packId: 'ISO9001-2026', version: '0.9.0', frameworkCode: 'ISO9001', edition: '2026', status: 'installed', preRelease: true, installedAt: '2026-09-18T03:00:00Z' },
    { packId: 'ISO9001-2015', version: '1.4.2', frameworkCode: 'ISO9001', edition: '2015', status: 'installed', preRelease: false, installedAt: '2025-06-01T03:00:00Z' },
    { packId: 'ISO22301-2019', version: '1.0.0', frameworkCode: 'ISO22301', edition: '2019', status: 'installed', preRelease: false, installedAt: '2026-04-02T03:00:00Z' },
    { packId: 'ISO37001-2025', version: '0.6.0', frameworkCode: 'ISO37001', edition: '2025', status: 'installed', preRelease: true, installedAt: '2026-09-01T03:00:00Z' },
  ];
}

function current(): State {
  state ??= { packs: initialPacks(), installing: new Map() };
  return state;
}

/** The organisations of the sample service (the store the operator console and Organisation export share). */
const orgsOf = (D: ControllerData | null): SampleOrg[] => sampleServiceOrgs(D);

/** The licence state of an entitlement on a day: valid until its last day, then grace, then read-only. */
function licenceOf(e: SampleEntitlement | null, today: string): { state: LicenceState; validUntil: string } | null {
  if (!e) return null;
  const until = e.validUntil ?? NO_END;
  const after = daysBetween(until, today);
  return { state: after <= 0 ? 'valid' : after <= e.graceDays ? 'grace' : 'read_only', validUntil: until };
}

function itemOf(o: SampleOrg, today: string): OrgItem {
  return {
    slug: o.slug, name: o.name, status: o.status, licence: licenceOf(o.entitlement, today), memberCount: o.memberCount, systemCount: o.systemCount,
    plan: o.entitlement?.plan ?? null, validUntil: o.entitlement?.validUntil ?? null,
    verifiedDomains: o.domains.filter((d) => d.status === 'verified').map((d) => d.domain).sort(), maxUsers: o.entitlement?.maxUsers ?? null,
    createdAt: o.createdAt, ...lifecycleOf(o),
  };
}

function detailOf(o: SampleOrg): OrgDetail {
  const e = o.entitlement;
  return {
    slug: o.slug, name: o.name, status: o.status, region: o.region, createdAt: o.createdAt, memberCount: o.memberCount, systemCount: o.systemCount,
    entitlement: e ? { plan: e.plan, source: e.source, maxUsers: e.maxUsers, maxManagementSystems: e.maxManagementSystems, validUntil: e.validUntil } : null,
    domains: o.domains.map((d) => ({ domain: d.domain, status: d.status })).sort((a, b) => a.domain.localeCompare(b.domain)),
    lastSignInAt: o.lastSignInAt,
    ...lifecycleOf(o),
  };
}

const opsExportOf = (e: SampleOrg['exports'][number]): OpsExport => ({
  id: e.id, status: e.status, requestedVia: e.requestedVia, requestedAt: e.requestedAt, completedAt: e.completedAt, expiresAt: e.expiresAt, isFinal: e.isFinal,
  partCount: e.partCount, sizeBytes: e.sizeBytes, downloadCount: e.downloadCount,
});

const deletionView = (d: DeletionView): DeletionView => ({ ...d, scheduledBy: d.scheduledBy ? { ...d.scheduledBy } : null, steps: d.steps.map((x) => ({ ...x })) });

/** The effects of a move of Milestone 3 J.8 on the sample organisation (D.2, D.5.1). */
function applyMove(o: SampleOrg, from: OrgStatus, to: OrgStatus, at: string): void {
  if (to === 'offboarding') {
    const reopened = from === 'archived';
    o.offboardingEndsAt = addDaysIso(at, reopened ? REOPEN_DAYS : READ_ONLY_DAYS);
    if (reopened && o.deletion?.status === 'scheduled') o.deletion = { ...o.deletion, status: 'cancelled', reason: `Reopened for an export: ${o.events[0]?.reason ?? ''}`.trim() };
    queueFinalExport(o, at, sampleId());
    return;
  }
  o.offboardingEndsAt = null;
  if (to === 'archived') {
    // The expiry removes the content of the final export once the organisation is archived (D.4).
    for (const e of o.exports) if (e.status === 'ready') e.status = 'expired';
    if (o.deletion?.status !== 'scheduled') {
      const final = o.exports.find((e) => e.isFinal);
      o.deletion = {
        id: sampleId(), status: 'scheduled', scheduledFor: addDaysIso(at, DELETION_GRACE_DAYS), scheduledBy: null, reason: o.events[0]?.reason ?? null,
        archivedAt: at, earliestAllowed: addDaysIso(at, 7), finalExportId: final?.id ?? null, startedAt: null, completedAt: null, failedStep: null, error: null,
        steps: [], vaultObjectsDeleted: null, certificateId: null,
      };
    }
  } else if (from === 'offboarding') {
    // Back to active: a final export stays downloadable for the usual 7 days (D.4).
    for (const e of o.exports) if (e.isFinal && e.status === 'ready' && !e.expiresAt) e.expiresAt = addDaysIso(at, 7);
  }
}

function viewOf(e: SampleEntitlement, o: SampleOrg): Entitlement {
  return {
    plan: e.plan, source: e.source, maxUsers: e.maxUsers, maxManagementSystems: e.maxManagementSystems, frameworks: [...e.frameworks],
    storageAdapters: [...e.storageAdapters], features: [...e.features], rateUserPerMinute: e.rateUserPerMinute, rateOrgPerMinute: e.rateOrgPerMinute,
    graceDays: e.graceDays, validFrom: e.validFrom, validUntil: e.validUntil, version: e.version, updatedAt: e.updatedAt,
    usage: { users: o.memberCount, managementSystems: o.systemCount },
  };
}

const domainView = ({ checks: _checks, ...d }: Domain & { checks: number }): Domain => d;

/** The domain of a typed name as the server stores it: the part after `@`, lower case, IDN in punycode; null when not one. */
export function normaliseDomain(input: string): string | null {
  let value = input.trim().replace(/\.$/, '');
  if (value.includes('@')) value = value.slice(value.lastIndexOf('@') + 1);
  try {
    value = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ? value : null;
}

/** A token of 32 random bytes in base64url, as the server makes it. */
function newToken(): string {
  const bytes = new Uint8Array(32);
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Now on the sample's day: the sample's today at the current local time, so new records sit beside the sample's. */
let sampleDay: string | null = null;
const nowIso = () => sampleNow(sampleDay);

/** The row values of a preset starting on `validFrom` (the server's `presetValues`). */
function presetValues(name: string, validFrom: string): Omit<SampleEntitlement, 'version' | 'updatedAt'> {
  const p = SAMPLE_PRESETS.find((x) => x.name === name)!;
  return {
    plan: p.name, source: 'preset', maxUsers: p.maxUsers, maxManagementSystems: p.maxManagementSystems, frameworks: [...p.frameworks],
    storageAdapters: [...p.storageAdapters], features: [...p.features], rateUserPerMinute: p.rateUserPerMinute, rateOrgPerMinute: p.rateOrgPerMinute,
    graceDays: p.graceDays, validFrom, validUntil: presetUntil(p, validFrom),
  };
}

/** The row values of an `ops.entitlements.set` body, or the refusal the server gives it. */
function valuesOfInput(body: EntitlementInput, today: string): Result<Omit<SampleEntitlement, 'version' | 'updatedAt'>> {
  if ('preset' in body) {
    if (!SAMPLE_PRESETS.some((p) => p.name === body.preset)) {
      return refuse(422, [`There is no plan preset ${body.preset} in license.plans`, `Tidak ada preset paket ${body.preset} di license.plans`], { slug: 'business-rule', messageKey: 'unknown_preset' });
    }
    return { ok: true, data: presetValues(body.preset, body.validFrom ?? today) };
  }
  if (body.validUntil !== null && body.validUntil < body.validFrom) {
    return titled(400, 'Invalid request', { slug: 'validation', errors: [{ path: 'body.validUntil', message: 'must not be before validFrom' }] });
  }
  return {
    ok: true,
    data: {
      plan: body.plan ?? null, source: 'manual', maxUsers: body.maxUsers, maxManagementSystems: body.maxManagementSystems, frameworks: [...body.frameworks],
      storageAdapters: [...body.storageAdapters], features: [...body.features], rateUserPerMinute: body.rateUserPerMinute, rateOrgPerMinute: body.rateOrgPerMinute,
      graceDays: body.graceDays, validFrom: body.validFrom, validUntil: body.validUntil,
    },
  };
}

export function createSampleAdapter(getD: () => ControllerData | null): OpsAdapter {
  const today = () => {
    const day = (getD() as { TODAY_S?: unknown } | null)?.TODAY_S;
    sampleDay = typeof day === 'string' ? day : null;
    return sampleDay ?? localIso(new Date());
  };
  const allOrgs = () => {
    today();
    return orgsOf(getD());
  };
  const find = (slug: string) => allOrgs().find((o) => o.slug === slug) ?? null;
  const unknown = <T,>(slug: string) => titled<T>(404, `Organisation ${slug} was not found`, { slug: 'not-found' });
  return {
    async health() {
      const health: Health = {
        components: [
          { name: 'database', status: 'ok', detail: 'SELECT 1 in 2 ms' },
          { name: 'storage-gateway', status: 'ok', detail: 'healthz in 14 ms' },
          { name: 'job-queue', status: 'ok', detail: 'pgboss: 6 queue(s) with jobs or workers' },
          { name: 'job-outbox', status: 'ok', detail: 'no stuck rows' },
          { name: 'mail', status: 'ok', detail: 'SMTP answered in 120 ms' },
          { name: 'telemetry', status: 'degraded', detail: 'OTLP endpoint not set' },
        ],
        migrations: [
          { schema: 'platform', latest: '0006_daily_job_run', expected: '0006_daily_job_run' },
          { schema: 'ref', latest: '0002_milestone2', expected: '0002_milestone2' },
          { schema: 'tenant', latest: '0008_milestone2', expected: '0008_milestone2' },
        ],
        queues: [],
        licences: allOrgs().flatMap((o) => {
          const licence = licenceOf(o.entitlement, today());
          return licence ? [{ org: o.slug, state: licence.state, validUntil: licence.validUntil }] : [];
        }),
      };
      return { ok: true, data: health };
    },
    async queues() {
      return {
        ok: true,
        data: [
          { name: 'freshness.recompute', waiting: 2, active: 1, failed: 0, oldestAgeSeconds: 4.2 },
          { name: 'notifications.dispatch', waiting: 0, active: 0, failed: 1, oldestAgeSeconds: 0 },
          { name: 'readiness.recompute', waiting: 1, active: 0, failed: 0, oldestAgeSeconds: 48 },
        ],
      };
    },
    async runJob(name, org) {
      if (org && !allOrgs().some((o) => o.slug === org)) return refuse(404, ['No organisation has this slug.', 'Tidak ada organisasi dengan slug ini.']);
      return { ok: true, data: `sample-${name}-${Date.now().toString(36)}` };
    },
    async diagnostics() {
      return refuse(0, NO_SERVER);
    },
    async organizations({ page, pageSize, q, status }) {
      const words = (q ?? '').toLowerCase().trim();
      const all = allOrgs().filter((o) => (!words || o.slug.includes(words) || o.name.toLowerCase().includes(words)) && (!status || o.status === status));
      const items = all.slice((page - 1) * pageSize, page * pageSize).map((o) => itemOf(o, today()));
      return { ok: true, data: { items, page, pageSize, total: all.length } };
    },
    async createOrganization(body) {
      if (allOrgs().some((o) => o.slug === body.slug)) {
        return refuse(409, ['An organisation with this slug exists.', 'Organisasi dengan slug ini sudah ada.'], { messageKey: 'org_exists', errors: [{ path: 'body.slug', message: 'An organisation with this slug exists' }] });
      }
      const preset = body.preset ? SAMPLE_PRESETS.find((p) => p.name === body.preset) : undefined;
      if (body.preset && !preset) {
        return refuse(422, [`There is no plan preset ${body.preset} in license.plans`, `Tidak ada preset paket ${body.preset} di license.plans`], { messageKey: 'unknown_preset' });
      }
      const from = today();
      const entitlement: SampleEntitlement | null = preset ? { ...presetValues(preset.name, from), version: 1, updatedAt: nowIso() } : null;
      allOrgs().push({
        slug: body.slug, name: body.name, status: 'active', region: 'id', createdAt: nowIso(), memberCount: 0, systemCount: 0, tenantAdmins: 0,
        entitlement, domains: [], events: [], lastSignInAt: null, offboardingEndsAt: null, deletion: null, exports: [],
      });
      const plan: [string, string] = entitlement
        ? [`The ${entitlement.plan} plan applies from ${entitlement.validFrom} to ${entitlement.validUntil}. `, `Paket ${entitlement.plan} berlaku sejak ${entitlement.validFrom} sampai ${entitlement.validUntil}. `]
        : ['', ''];
      return {
        ok: true,
        data: {
          slug: body.slug, invitationSent: true, invitationUrl: null,
          message: [
            `Organisation created. The slug ${body.slug} cannot be changed. ${plan[0]}The invitation was sent to ${body.firstAdmin.email}.`,
            `Organisasi dibuat. Slug ${body.slug} tidak dapat diubah. ${plan[1]}Undangan dikirim ke ${body.firstAdmin.email}.`,
          ],
        },
      };
    },
    async organization(slug) {
      const o = find(slug);
      return o ? { ok: true, data: detailOf(o) } : unknown(slug);
    },
    async changeStatus(slug, body) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const from = o.status;
      const to = body.status;
      // Milestone 3 J.8: an archived organisation moves back to offboarding only while its deletion is scheduled.
      const reopenRefused = from === 'archived' && to === 'offboarding' && o.deletion?.status !== 'scheduled';
      if (!STATUS_MOVES[from].includes(to) || reopenRefused) {
        const allowed = STATUS_MOVES[from].filter((x) => from !== 'archived' || o.deletion?.status === 'scheduled' || x !== 'offboarding');
        const reopen: [string, string] = from === 'archived' ? [' It can move back to offboarding only while its deletion is scheduled.', ' Organisasi dapat kembali ke offboarding hanya selama penghapusannya dijadwalkan.'] : ['', ''];
        const en = from === to ? `Organisation ${slug} is already ${to}.` : `Organisation ${slug} is ${from} and cannot move to ${to}. ${allowed.length && from !== 'archived' ? `From ${from} it can move to ${allowed.join(' or ')}.` : `${from} is final.`}${reopen[0]}`;
        const id = from === to ? `Organisasi ${slug} sudah berstatus ${to}.` : `Organisasi ${slug} berstatus ${from} dan tidak dapat dipindahkan ke ${to}. ${allowed.length && from !== 'archived' ? `Dari ${from} organisasi dapat dipindahkan ke ${allowed.join(' atau ')}.` : `${from} adalah status akhir.`}${reopen[1]}`;
        return refuse(409, [en, id], { slug: 'transition-not-allowed', messageKey: 'invalid_status_transition' });
      }
      if (body.reason.trim().length < 3) return titled(400, 'Invalid request', { slug: 'validation', errors: [{ path: 'body.reason', message: 'Too small: expected string to have >=3 characters' }] });
      if (needsSlug(to) && body.confirmSlug !== slug) {
        return refuse(422, [`Moving organisation ${slug} to ${to} needs confirmSlug equal to the slug ${slug}.`, `Memindahkan organisasi ${slug} ke ${to} memerlukan confirmSlug yang sama dengan slug ${slug}.`], { slug: 'business-rule', messageKey: 'confirmation_mismatch' });
      }
      const at = nowIso();
      o.status = to;
      o.events.unshift({ id: `ev-${slug}-${o.events.length + 1}-${Date.now().toString(36)}`, from, to, reason: body.reason.trim(), actor: { handle: 'ops.owner', displayName: 'Platform owner' }, at });
      applyMove(o, from, to, at);
      const sessionsRevoked = to === 'suspended' || to === 'archived' ? Math.ceil(o.memberCount / 3) : 0;
      const admins = o.tenantAdmins;
      return {
        ok: true,
        data: {
          from, to, sessionsRevoked, tenantAdmins: admins, tenantAdminsEmailed: admins,
          message: [
            `Organisation ${slug} moved from ${from} to ${to}. ${sessionsRevoked} sessions were ended. ${admins} of ${admins} Tenant Admins were emailed.`,
            `Organisasi ${slug} dipindahkan dari ${from} ke ${to}. ${sessionsRevoked} sesi diakhiri. ${admins} dari ${admins} Tenant Admin dikirimi email.`,
          ],
        },
      };
    },
    async events(slug, page, pageSize) {
      const o = find(slug);
      if (!o) return unknown(slug);
      return { ok: true, data: { items: o.events.slice((page - 1) * pageSize, page * pageSize).map((e) => ({ ...e })), page, pageSize, total: o.events.length } };
    },
    async domains(slug) {
      const o = find(slug);
      if (!o) return unknown(slug);
      return { ok: true, data: [...o.domains].sort((a, b) => a.domain.localeCompare(b.domain)).map(domainView) };
    },
    async addDomain(slug, input) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const domain = normaliseDomain(input);
      if (!domain) return titled(400, 'Invalid request', { slug: 'validation', errors: [{ path: 'body.domain', message: `${JSON.stringify(input.trim())} is not an email domain such as example.co.id` }] });
      if (o.status === 'archived') return titled(409, 'Conflict', { slug: 'conflict', messageKey: 'organization_archived' });
      if (FREE_MAIL.has(domain) || [...FREE_MAIL].some((f) => domain.endsWith(`.${f}`))) {
        return refuse(422, [
          `${input.trim()} is a free mail domain that anyone can use; only a domain the organisation owns can be verified.`,
          `${input.trim()} adalah domain email gratis yang dapat dipakai siapa saja; hanya domain milik organisasi yang dapat diverifikasi.`,
        ], { slug: 'business-rule', messageKey: 'domain_not_allowed' });
      }
      if (allOrgs().some((x) => x !== o && x.domains.some((d) => d.domain === domain && d.status === 'verified'))) {
        return refuse(409, [
          `The domain ${domain} is already verified for another organisation. A verified domain belongs to one organisation only; remove it there first.`,
          `Domain ${domain} sudah diverifikasi untuk organisasi lain. Domain terverifikasi hanya dimiliki satu organisasi; hapus dulu di sana.`,
        ], { slug: 'conflict', messageKey: 'domain_taken' });
      }
      const existing = o.domains.find((d) => d.domain === domain);
      if (existing?.status === 'verified') {
        return refuse(409, [`The domain ${domain} is already verified for ${slug}.`, `Domain ${domain} sudah diverifikasi untuk ${slug}.`], { slug: 'conflict', messageKey: 'domain_already_verified' });
      }
      const requestedAt = nowIso();
      const row = {
        domain, status: 'pending' as const, method: 'dns' as const, requestedAt, verifiedAt: null, lastCheckedAt: null,
        pendingUntil: new Date(Date.parse(requestedAt) + 7 * 864e5).toISOString(), txtName: `_mscd-verify.${domain}`, checks: 0,
      };
      if (existing) Object.assign(existing, row);
      else o.domains.push(row);
      return { ok: true, data: { domain, txtName: row.txtName, txtValue: `mscd-verify=${newToken()}`, status: 'pending' } };
    },
    async verifyDomain(slug, domain) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const d = o.domains.find((x) => x.domain === domain);
      if (!d) return titled(404, `The organisation ${slug} has no domain ${domain}`, { slug: 'not-found' });
      if (o.status === 'archived') return titled(409, 'Conflict', { slug: 'conflict', messageKey: 'organization_archived' });
      if (d.method === 'manual') {
        return refuse(409, [
          `The domain ${domain} was verified by the operator command without a DNS record, so there is nothing to check.`,
          `Domain ${domain} diverifikasi dengan perintah operator tanpa catatan DNS, sehingga tidak ada yang diperiksa.`,
        ], { slug: 'conflict', messageKey: 'domain_not_dns' });
      }
      const at = nowIso();
      d.lastCheckedAt = at;
      // The customer's record shows up from the second lookup on (the first check after "Add" finds nothing yet).
      const found = d.status === 'verified' || (d.status === 'pending' && d.checks >= 1);
      d.checks += 1;
      if (found && d.status === 'pending') {
        d.status = 'verified';
        d.verifiedAt = at;
        d.pendingUntil = null;
      }
      return { ok: true, data: { ...domainView(d), recordFound: found } };
    },
    async removeDomain(slug, domain) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const at = o.domains.findIndex((x) => x.domain === domain);
      if (at < 0) return titled(404, `The organisation ${slug} has no domain ${domain}`, { slug: 'not-found' });
      o.domains.splice(at, 1);
      return { ok: true, data: null };
    },
    async entitlement(slug) {
      const o = find(slug);
      if (!o) return unknown(slug);
      if (!o.entitlement) return { ok: true, data: { entitlement: null, etag: '*' } };
      const entitlement = viewOf(o.entitlement, o);
      return { ok: true, data: { entitlement, etag: entitlementEtag(entitlement) } };
    },
    async setEntitlement(slug, body, ifMatch) {
      const o = find(slug);
      if (!o) return unknown(slug);
      if (!ifMatch) return titled(428, 'Precondition required', { slug: 'precondition-required' });
      if (ifMatch !== '*' && (!o.entitlement || ifMatch !== entitlementEtag(o.entitlement))) return titled(412, 'Precondition failed', { slug: 'precondition-failed' });
      const values = valuesOfInput(body, today());
      if (!values.ok) return values;
      const version = (o.entitlement?.version ?? 0) + 1;
      o.entitlement = { ...values.data, version, updatedAt: nowIso() };
      const entitlement = viewOf(o.entitlement, o);
      const warnings: [string, string][] = [];
      if (o.memberCount > entitlement.maxUsers) {
        warnings.push([
          `The organisation has ${o.memberCount} active members and the new limit is ${entitlement.maxUsers}. Nobody loses access, but no one can be added or invited until the number is below the limit.`,
          `Organisasi ini memiliki ${o.memberCount} anggota aktif dan batas barunya ${entitlement.maxUsers}. Tidak ada yang kehilangan akses, tetapi tidak ada yang dapat ditambahkan atau diundang sampai jumlahnya di bawah batas.`,
        ]);
      }
      if (o.systemCount > entitlement.maxManagementSystems) {
        warnings.push([
          `The organisation has ${o.systemCount} management systems and the new limit is ${entitlement.maxManagementSystems}. The systems stay as they are, but no new one can be created.`,
          `Organisasi ini memiliki ${o.systemCount} sistem manajemen dan batas barunya ${entitlement.maxManagementSystems}. Sistem yang ada tetap seperti semula, tetapi sistem baru tidak dapat dibuat.`,
        ]);
      }
      return { ok: true, data: { entitlement, etag: entitlementEtag(entitlement), warnings } };
    },
    async plans() {
      return { ok: true, data: SAMPLE_PRESETS.map((p) => ({ ...p, frameworks: [...p.frameworks], storageAdapters: [...p.storageAdapters], features: [...p.features] })) };
    },
    async installLicence(org, licence) {
      const doc = licence && typeof licence === 'object' && !Array.isArray(licence) ? (licence as Record<string, unknown>) : null;
      if (!doc || typeof doc.license_id !== 'string' || typeof doc.signature !== 'string') {
        return refuse(400, ['This document is not a signed licence.', 'Dokumen ini bukan lisensi bertanda tangan.'], { errors: [{ path: 'body.licence', message: 'license_id and signature are required' }] });
      }
      const o = find(org);
      if (!o) return unknown(org);
      const until = typeof doc.valid_until === 'string' ? doc.valid_until : '2027-12-31';
      const number = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback);
      o.entitlement = {
        plan: null, source: 'signed_licence',
        maxUsers: number(doc.max_users, o.entitlement?.maxUsers ?? 50), maxManagementSystems: number(doc.max_management_systems, o.entitlement?.maxManagementSystems ?? 3),
        frameworks: o.entitlement?.frameworks ?? [], storageAdapters: o.entitlement?.storageAdapters ?? ['managed_vault', 'm365', 'google_drive'],
        features: o.entitlement?.features ?? ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
        rateUserPerMinute: null, rateOrgPerMinute: null, graceDays: 30, validFrom: today(), validUntil: until,
        version: (o.entitlement?.version ?? 0) + 1, updatedAt: nowIso(),
      };
      return { ok: true, data: null };
    },
    async packs() {
      const s = current();
      for (const [key, left] of s.installing) {
        if (left > 0) {
          s.installing.set(key, left - 1);
          continue;
        }
        s.installing.delete(key);
        const row = s.packs.find((p) => `${p.packId}@${p.version}` === key);
        if (row) {
          for (const p of s.packs) if (p.packId === row.packId && p !== row && p.status === 'installed') p.status = 'superseded';
          row.status = 'installed';
          row.installedAt = new Date().toISOString();
        }
      }
      return { ok: true, data: s.packs.map((p) => ({ ...p })) };
    },
    async importPack(_file, fileName) {
      const m = /^(ISO\d+-\d{4})[-_ ](\d+\.\d+\.\d+)\.(bundle|pack)$/i.exec(fileName);
      if (!m) {
        return refuse(400, ['The bundle signature could not be checked: this is not a signed pack bundle.', 'Tanda tangan bundel tidak dapat diperiksa: ini bukan bundel paket bertanda tangan.'], { messageKey: 'pack.signature', errors: [{ path: 'body.bundle', message: 'not a signed pack bundle' }] });
      }
      const packId = m[1].toUpperCase();
      const version = m[2];
      const s = current();
      if (s.packs.some((p) => p.packId === packId && p.version === version && p.status === 'installed')) {
        return { ok: true, data: { packId, version, status: 'unchanged', message: [`${packId} ${version} is already installed`, `${packId} ${version} sudah terpasang`] } };
      }
      const [framework, edition] = packId.split('-');
      s.packs.unshift({ packId, version, frameworkCode: framework, edition, status: 'validating', preRelease: false, installedAt: null });
      s.installing.set(`${packId}@${version}`, 1);
      return { ok: true, data: { packId, version, status: 'queued', message: [`${packId} ${version} was verified and is being installed`, `${packId} ${version} telah diverifikasi dan sedang dipasang`] } };
    },
    async organizationNames() {
      return { ok: true, data: orgsOf(getD()).map((o) => ({ slug: o.slug, name: o.name })) };
    },
    async exports(slug) {
      const o = find(slug);
      if (!o) return unknown(slug);
      advanceExports(o, nowIso());
      return { ok: true, data: o.exports.map(opsExportOf) };
    },
    async startExport(slug, reason) {
      const o = find(slug);
      if (!o) return unknown(slug);
      if (reason.trim().length < 3) return titled(400, 'Invalid request', { slug: 'validation', errors: [{ path: 'body.reason', message: 'Too small: expected string to have >=3 characters' }] });
      if (!EXPORTABLE.includes(o.status)) {
        return refuse(409, [
          `Organisation ${slug} is ${o.status}. An export can be made while it is active or offboarding.`,
          `Organisasi ${slug} berstatus ${o.status}. Ekspor dapat dibuat selama organisasi aktif atau dalam masa offboarding.`,
        ], { slug: 'conflict', messageKey: 'export_not_available' });
      }
      const at = nowIso();
      if (inFlight(o, at)) {
        return refuse(409, [
          'Another export of this organisation is waiting for approval or being built. Wait until it is ready, rejected or failed.',
          'Ekspor lain dari organisasi ini sedang menunggu persetujuan atau sedang dibuat. Tunggu sampai ekspor itu siap, ditolak atau gagal.',
        ], { slug: 'conflict', messageKey: 'export_in_progress' });
      }
      const id = sampleId();
      o.exports.unshift(newExport({ id, status: 'queued', requestedVia: 'operator', requestedAt: at }));
      return {
        ok: true,
        data: {
          id,
          message: [
            `The export of ${slug} was queued; its Tenant Admins are told and download it when it is ready`,
            `Ekspor ${slug} diantrekan; Tenant Admin-nya diberi tahu dan mengunduhnya setelah siap`,
          ],
        },
      };
    },
    async deletion(slug) {
      const o = find(slug);
      if (!o) return unknown(slug);
      // A retried purge finishes on the next read, as the worker would.
      if (o.deletion?.status === 'running') finishPurge(o, nowIso(), sampleId());
      return { ok: true, data: o.deletion ? deletionView(o.deletion) : null };
    },
    async scheduleDeletion(slug, body) {
      const o = find(slug);
      if (!o) return unknown(slug);
      if (o.status !== 'archived') {
        return refuse(409, [
          `Organisation ${slug} is ${o.status}: only an archived organisation has a deletion date`,
          `Organisasi ${slug} berstatus ${o.status}: hanya organisasi yang diarsipkan yang memiliki tanggal penghapusan`,
        ], { slug: 'conflict', messageKey: 'deletion_not_archived' });
      }
      if (body.confirmSlug !== slug) {
        return refuse(422, [`Moving organisation ${slug} to archived needs confirmSlug equal to the slug ${slug}.`, `Memindahkan organisasi ${slug} ke archived memerlukan confirmSlug yang sama dengan slug ${slug}.`], { slug: 'business-rule', messageKey: 'confirmation_mismatch' });
      }
      const at = nowIso();
      const archivedAt = o.events.find((e) => e.to === 'archived')?.at ?? o.deletion?.archivedAt ?? at;
      const earliest = addDaysIso(archivedAt, 7);
      if (Date.parse(body.scheduledFor) < Date.parse(earliest)) {
        return refuse(409, [
          `The deletion of ${slug} cannot be earlier than ${earliest} (archived on ${archivedAt.slice(0, 10)} plus 7 days)`,
          `Penghapusan ${slug} tidak boleh lebih awal dari ${earliest} (diarsipkan pada ${archivedAt.slice(0, 10)} ditambah 7 hari)`,
        ], { slug: 'conflict', messageKey: 'deletion_too_soon' });
      }
      if (Date.parse(body.scheduledFor) < Date.parse(at)) {
        return refuse(409, [
          `The deletion date ${body.scheduledFor} of ${slug} is in the past; choose now or later`,
          `Tanggal penghapusan ${body.scheduledFor} untuk ${slug} sudah lewat; pilih sekarang atau sesudahnya`,
        ], { slug: 'conflict', messageKey: 'deletion_too_soon' });
      }
      const open = o.deletion && o.deletion.status !== 'cancelled' ? o.deletion : null;
      if (open && open.status !== 'scheduled') {
        return refuse(409, [
          `The deletion of ${slug} is ${open.status}; its date can no longer change${open.status === 'failed' ? ' (retry it instead)' : ''}`,
          `Penghapusan ${slug} berstatus ${open.status}; tanggalnya tidak dapat diubah lagi${open.status === 'failed' ? ' (coba lagi sebagai gantinya)' : ''}`,
        ], { slug: 'conflict', messageKey: 'deletion_in_progress' });
      }
      const by = { handle: 'ops.owner', displayName: 'Platform owner' };
      o.deletion = open
        ? { ...open, scheduledFor: body.scheduledFor, scheduledBy: by, reason: body.reason }
        : {
          id: sampleId(), status: 'scheduled', scheduledFor: body.scheduledFor, scheduledBy: by, reason: body.reason, archivedAt, earliestAllowed: earliest,
          finalExportId: o.exports.find((e) => e.isFinal)?.id ?? null, startedAt: null, completedAt: null, failedStep: null, error: null, steps: [],
          vaultObjectsDeleted: null, certificateId: null,
        };
      const day = body.scheduledFor.slice(0, 10);
      return {
        ok: true,
        data: { id: o.deletion.id, status: 'scheduled', scheduledFor: body.scheduledFor, message: [`The deletion of ${slug} is scheduled for ${day}.`, `Penghapusan ${slug} dijadwalkan pada ${day}.`] },
      };
    },
    async cancelDeletion(slug, reason) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const open = o.deletion && o.deletion.status !== 'cancelled' ? o.deletion : null;
      if (!open || open.status !== 'scheduled') {
        return titled(409, `Organisation ${slug} has no scheduled deletion to cancel${open ? ` (it is ${open.status})` : ''}`, { slug: 'conflict', messageKey: 'deletion_in_progress' });
      }
      o.deletion = { ...open, status: 'cancelled', reason: `Cancelled: ${reason.trim()}` };
      return {
        ok: true,
        data: {
          id: open.id, status: 'cancelled', scheduledFor: open.scheduledFor,
          message: [
            `The deletion of ${slug} is cancelled. The organisation stays archived until a deletion is scheduled again.`,
            `Penghapusan ${slug} dibatalkan. Organisasi tetap diarsipkan sampai penghapusan dijadwalkan lagi.`,
          ],
        },
      };
    },
    async retryDeletion(slug, reason) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const open = o.deletion && o.deletion.status !== 'cancelled' ? o.deletion : null;
      if (!open || open.status !== 'failed') {
        return titled(409, `The deletion of ${slug} has not failed${open ? ` (it is ${open.status})` : ''}; only a failed purge is retried`, { slug: 'conflict', messageKey: 'deletion_in_progress' });
      }
      const step = open.failedStep ?? 'check';
      o.deletion = { ...open, status: 'running', error: null, reason: open.reason, steps: (open.steps.length ? open.steps : pendingSteps()).map((s) => (s.status === 'failed' ? { ...s, status: 'running' as const } : s)) };
      void reason;
      return {
        ok: true,
        data: {
          id: open.id, status: 'running', scheduledFor: open.scheduledFor,
          message: [`The purge of ${slug} runs again from the step ${step}.`, `Penghapusan ${slug} dijalankan lagi dari langkah ${step}.`],
        },
      };
    },
    async certificate(slug) {
      const o = find(slug);
      if (!o) return unknown(slug);
      const d = o.deletion;
      if (!d) return titled(404, `Organisation ${slug} has no deletion`, { slug: 'not-found' });
      if (d.status !== 'completed') return titled(409, `The deletion of ${slug} is ${d.status}; the certificate exists once it has completed`, { slug: 'conflict' });
      return { ok: true, data: textFile(certificateText(o, d), `deletion-certificate-${slug}-${(d.completedAt ?? '').slice(0, 10)}.json`, 'application/json') };
    },
    // The accounts and platform operators of the sample service (M2-19).
    ...sampleAccounts(getD, nowIso),
  };
}
