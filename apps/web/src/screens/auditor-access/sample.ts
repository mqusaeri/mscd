// Sample adapter of the Auditor access screen (MILESTONE-2 M2-15, C.6): the guest auditor grants and evidence packs of
// each sample organisation, kept for the browser session. The ISMS starts with the grant of its certification body's
// lead auditor and an earlier, revoked one; each system with evidence has one ready pack for its next audit, whose
// manifest lists the evidence of the sample snapshot (the CSV manifest is made in the browser; the sample has no PDF
// manifest or archive file). Loaded only through the dynamic import of adapter.ts, so the api build holds none of it.
import type { ControllerData, MsId } from '../../data/types';
import type { AuditorAccessAdapter, GrantModel, PackModel } from './model';
import { textFile } from './shared';

interface OrgState {
  grants: Map<MsId, GrantModel[]>;
}

const STATES = new Map<string, OrgState>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleAccess(): void {
  STATES.clear();
  sequence = 0;
}

/** The sample's first grants of a system: the lead auditor of the ISMS's certification body, and a revoked one. */
function seedGrants(ms: MsId, today: string): GrantModel[] {
  if (ms !== 'isms') return [];
  const at = (days: number, time: string) => {
    const d = new Date(`${today}T${time}Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().replace('.000Z', 'Z');
  };
  return [
    {
      id: 'sample-grant-isms-1', email: 'dwi.hartanto@sertifikasi-nusantara.co.id', createdBy: 'rina', createdAt: at(-7, '03:00:00'), expiresAt: at(7, '03:00:00'),
      linkUsedAt: at(-7, '05:12:00'), lastUsedAt: at(-1, '08:40:00'), revokedAt: null, revokedBy: null, active: true,
    },
    {
      id: 'sample-grant-isms-0', email: 'auditor.stage2@sertifikasi-nusantara.co.id', createdBy: 'rina', createdAt: '2025-03-03T02:00:00Z', expiresAt: '2025-03-17T02:00:00Z',
      linkUsedAt: '2025-03-03T04:30:00Z', lastUsedAt: '2025-03-12T09:15:00Z', revokedAt: '2025-03-14T06:00:00Z', revokedBy: 'rina', active: false,
    },
  ];
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null): AuditorAccessAdapter {
  const D = () => getD();
  const today = () => D()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const state = (): OrgState => {
    const key = getOrg() ?? (D()?.MS ?? []).map((m) => m.id).sort().join(',');
    let s = STATES.get(key);
    if (!s) {
      s = { grants: new Map() };
      STATES.set(key, s);
    }
    return s;
  };
  const grantsOf = (ms: MsId): GrantModel[] => {
    const s = state();
    let list = s.grants.get(ms);
    if (!list) {
      list = seedGrants(ms, today());
      s.grants.set(ms, list);
    }
    return list;
  };
  // The sample's clock: the snapshot's date at the browser's time of day, so grants expire against the sample date.
  const now = () => new Date(`${today()}T${new Date().toISOString().slice(11)}`);
  const withState = (g: GrantModel): GrantModel => ({ ...g, active: !g.revokedAt && Date.parse(g.expiresAt) > now().getTime() });
  const evidenceOf = (ms: MsId) => D()?.bundles?.[ms]?.evs ?? [];
  const packsOf = (ms: MsId): PackModel[] => {
    const evs = evidenceOf(ms);
    if (!evs.length) return [];
    const system = D()?.MS?.find((m) => m.id === ms);
    const next = (D()?.EVENTS?.[ms] ?? []).find((e) => e.next);
    const label = next ? (Array.isArray(next.short ?? next.t) ? (next.short ?? next.t)[0] : String(next.short ?? next.t)) : 'Audit';
    return [{
      id: `sample-pack-${ms}-1`, status: 'ready', builtAt: `${today()}T03:00:00Z`, packFolder: `/Compliance/_packs/${system?.short ?? ms.toUpperCase()}/${label}/`,
      itemCount: evs.length, exceptionCount: evs.filter((e) => !['ok', 'nohash', 'pending'].includes(e.integ)).length, files: ['manifest_csv'],
    }];
  };
  return {
    sample: true,
    async grants(ms) {
      return { ok: true, data: grantsOf(ms).map(withState).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    },
    async grant(ms, body) {
      sequence += 1;
      const at = now();
      const expires = new Date(at.getTime() + body.expiresInDays * 86_400_000);
      const g: GrantModel = {
        id: `sample-grant-${ms}-new-${sequence}`, email: body.email, createdBy: 'rina', createdAt: at.toISOString(), expiresAt: expires.toISOString(),
        linkUsedAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null, active: true,
      };
      grantsOf(ms).unshift(g);
      return { ok: true, data: { grantId: g.id, expiresAt: g.expiresAt, message: null } };
    },
    async revoke(ms, grant) {
      const list = grantsOf(ms);
      const g = list.find((x) => x.id === grant.id);
      if (!g) return { ok: false, error: { status: 404, message: ['Grant not found', 'Akses tidak ditemukan'] } };
      if (g.revokedAt) return { ok: false, error: { status: 409, message: ['This access is already revoked', 'Akses ini sudah dicabut'] } };
      g.revokedAt = now().toISOString();
      g.revokedBy = 'rina';
      g.active = false;
      return { ok: true, data: true };
    },
    async packs(ms, page, pageSize) {
      const all = packsOf(ms);
      return { ok: true, data: { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length } };
    },
    async download(ms, pack) {
      const rows = [['Evidence', 'Requirements', 'Produced', 'Version', 'Hash algorithm', 'Integrity', 'Location']];
      for (const e of evidenceOf(ms)) rows.push([e.code, e.ctrl, e.prod, e.ver, e.hashAlg, e.integ, e.path]);
      const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return { ok: true, data: textFile(text, `${ms}-evidence-pack-${pack.id.slice(-6)}-manifest.csv`, 'text/csv;charset=utf-8') };
    },
  };
}
