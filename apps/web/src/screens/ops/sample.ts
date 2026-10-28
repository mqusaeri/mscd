// Sample adapter of the operator console: a healthy installation, the queues of a quiet afternoon, the three sample
// organisations of the snapshot and their licences, and the packs of the sample (ISO 9001 and ISO 37001 in their
// newer editions). Created organisations, installed licences and packs stay for the browser session; an imported
// bundle shows as "Installing" on the next read and as installed on the one after, as the worker would do it.
import type { ControllerData } from '../../data/types';
import type { Health, OpsAdapter, OrgItem, PackItem, Result } from './model';

const NO_SERVER: [string, string] = ['The sample build has no server to read diagnostics from.', 'Versi contoh tidak memiliki server untuk membaca diagnostik.'];

const refuse = <T,>(status: number, message: readonly [string, string], extra: { messageKey?: string; rule?: string; errors?: { path: string; message: string }[] } = {}): Result<T> => ({
  ok: false,
  error: { status, message: [message[0], message[1]], ...extra },
});

interface State {
  created: OrgItem[];
  licences: Record<string, string>;
  packs: PackItem[];
  /** Imported packs still installing: the number of reads left until they are installed. */
  installing: Map<string, number>;
}
let state: State | null = null;

/** Forgets the changes of the session (unit tests). */
export function resetSampleOps(): void {
  state = null;
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
  state ??= { created: [], licences: {}, packs: initialPacks(), installing: new Map() };
  return state;
}

/** The organisations of the sample snapshot as the operator sees them. */
function sampleOrgs(D: ControllerData | null): OrgItem[] {
  const orgs = D?.orgs ?? [];
  const members: Record<string, number> = { ndt: 86, bsd: 41, rmn: 23 };
  const states: Record<string, { state: 'valid' | 'grace'; validUntil: string }> = {
    ndt: { state: 'valid', validUntil: '2027-03-31' },
    bsd: { state: 'grace', validUntil: '2026-09-15' },
    rmn: { state: 'valid', validUntil: '2027-01-31' },
  };
  return orgs.map((o, i) => ({
    slug: o.id, name: o.name, status: 'active', licence: states[o.id] ?? { state: 'valid', validUntil: '2027-03-31' },
    memberCount: members[o.id] ?? 10, systemCount: o.ms.length, plan: i === 0 ? 'standard' : null, createdAt: `2026-0${i + 1}-15T03:00:00Z`,
  }));
}

export function createSampleAdapter(getD: () => ControllerData | null): OpsAdapter {
  const allOrgs = () => {
    const s = current();
    return [...sampleOrgs(getD()), ...s.created].map((o) => (s.licences[o.slug] ? { ...o, licence: { state: 'valid' as const, validUntil: s.licences[o.slug] } } : o));
  };
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
        licences: allOrgs().filter((o) => o.licence).map((o) => ({ org: o.slug, state: o.licence!.state, validUntil: o.licence!.validUntil })),
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
    async organizations({ page, pageSize, q }) {
      const words = (q ?? '').toLowerCase().trim();
      const all = allOrgs().filter((o) => !words || o.slug.includes(words) || o.name.toLowerCase().includes(words));
      return { ok: true, data: { items: all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: all.length } };
    },
    async createOrganization(body) {
      if (allOrgs().some((o) => o.slug === body.slug)) {
        return refuse(409, ['An organisation with this slug exists.', 'Organisasi dengan slug ini sudah ada.'], { messageKey: 'org_exists', errors: [{ path: 'body.slug', message: 'An organisation with this slug exists' }] });
      }
      current().created.push({ slug: body.slug, name: body.name, status: 'active', licence: null, memberCount: 1, systemCount: 0, plan: null, createdAt: new Date().toISOString() });
      return {
        ok: true,
        data: {
          slug: body.slug, invitationSent: true, invitationUrl: null,
          message: [`Organisation created. The slug ${body.slug} cannot be changed.`, `Organisasi dibuat. Slug ${body.slug} tidak dapat diubah.`],
        },
      };
    },
    async installLicence(org, licence) {
      const doc = licence && typeof licence === 'object' && !Array.isArray(licence) ? (licence as Record<string, unknown>) : null;
      if (!doc || typeof doc.license_id !== 'string' || typeof doc.signature !== 'string') {
        return refuse(400, ['This document is not a signed licence.', 'Dokumen ini bukan lisensi bertanda tangan.'], { errors: [{ path: 'body.licence', message: 'license_id and signature are required' }] });
      }
      current().licences[org] = typeof doc.valid_until === 'string' ? doc.valid_until : '2027-12-31';
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
    async resetMfa(email) {
      const people = Object.values(getD()?.PEOPLE ?? {}).map(([name]) => `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`);
      if (!people.includes(email.trim().toLowerCase())) return refuse(404, ['No account with this email has a second factor.', 'Tidak ada akun dengan email ini yang memiliki faktor kedua.']);
      return { ok: true, data: null };
    },
  };
}
