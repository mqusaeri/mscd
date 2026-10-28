// Sample adapter of the Audit trail screen (MILESTONE-2 M2-15, C.6): an audit trail made from the sample snapshot, the
// same every time for an organisation. Each system gets the changes the sample shows (controls implemented, documents
// approved, evidence linked, reminders, the audit event) by the people who hold them, plus sign-ins and a nightly
// system job at organisation level. The chain verifies as intact; the anchors and the CSV are made in the browser.
// Loaded only through the dynamic import of adapter.ts, so the api build holds none of it (R-13).
import type { ControllerData, MsId } from '../../data/types';
import { textFile } from '../auditor-access/shared';
import type { AuditTrailAdapter, EntryModel } from './model';

const at = (today: string, minutesAgo: number): string => new Date(Date.parse(`${today}T09:00:00Z`) - minutesAgo * 60_000).toISOString().replace('.000Z', 'Z');

interface Raw {
  minutes: number;
  handle: string | null;
  kind: EntryModel['actor']['kind'];
  action: string;
  entityType: string | null;
  entityCode: string | null;
  ms: MsId | null;
  before?: unknown;
  after?: unknown;
}

/** The entries of an organisation, newest first, numbered like a chain (the newest has the highest number). */
export function sampleEntries(D: ControllerData | null): EntryModel[] {
  const today = D?.TODAY_S ?? '2026-09-29';
  const raw: Raw[] = [];
  let step = 7;
  const next = () => (step += 37);
  for (const m of D?.MS ?? []) {
    const bundle = D?.bundles?.[m.id];
    for (const r of (bundle?.reqs ?? []).filter((x) => x.st === 'implemented').slice(0, 8)) {
      raw.push({ minutes: next(), handle: m.mgr, kind: 'user', action: 'applicability.transition', entityType: 'applicability_entry', entityCode: r.id, ms: m.id, before: { implementation_status: 'complete' }, after: { implementation_status: 'implemented' } });
      raw.push({ minutes: next(), handle: r.owner && r.owner !== 'none' ? r.owner : m.mgr, kind: 'user', action: 'applicability.transition', entityType: 'applicability_entry', entityCode: r.id, ms: m.id, before: { implementation_status: 'in_progress' }, after: { implementation_status: 'complete' } });
    }
    for (const d of (bundle?.docs ?? []).filter((x) => x.st === 'approved').slice(0, 4)) {
      raw.push({ minutes: next(), handle: d.approver ?? m.mgr, kind: 'user', action: 'document.transition', entityType: 'document', entityCode: d.id, ms: m.id, before: { status: 'in_review' }, after: { status: 'approved', version: d.ver } });
    }
    for (const e of (bundle?.evs ?? []).slice(0, 5)) {
      raw.push({ minutes: next(), handle: e.owner && e.owner !== 'none' ? e.owner : m.mgr, kind: 'user', action: 'evidence.file_linked', entityType: 'evidence', entityCode: e.code, ms: m.id, after: { version: e.ver, hash_algorithm: e.hashAlg } });
    }
    const event = (D?.EVENTS?.[m.id] ?? []).find((x) => x.next);
    if (event) {
      const label = Array.isArray(event.t) ? event.t[0] : String(event.t);
      raw.push({ minutes: next(), handle: m.mgr, kind: 'user', action: 'audit_event.updated', entityType: 'audit_event', entityCode: label, ms: m.id, before: { lead_auditor_name: null }, after: { lead_auditor_name: typeof m.lead === 'string' ? m.lead : m.lead[0] } });
    }
    raw.push({ minutes: next(), handle: m.mgr, kind: 'user', action: 'reminder.sent', entityType: null, entityCode: null, ms: m.id, after: { scope: 'open_chain_items' } });
    raw.push({ minutes: next(), handle: null, kind: 'system', action: 'freshness.downgrade', entityType: 'evidence', entityCode: (bundle?.evs ?? [])[0]?.code ?? null, ms: m.id, before: { freshness: 'fresh' }, after: { freshness: 'aging' } });
  }
  for (const handle of ['rina', 'hendra', 'maya', 'bagus']) {
    if (D?.PEOPLE?.[handle]) raw.push({ minutes: next(), handle, kind: 'user', action: 'auth.login', entityType: null, entityCode: null, ms: null, after: { method: 'password_totp' } });
  }
  raw.sort((a, b) => a.minutes - b.minutes);
  const total = raw.length;
  return raw.map((r, i): EntryModel => {
    const system = r.ms ? D?.MS?.find((m) => m.id === r.ms) : null;
    return {
      key: `sample-${total - i}`,
      seq: 1000 + total - i,
      occurredAt: at(today, r.minutes),
      actor: { handle: r.handle, displayName: r.handle ? D?.PEOPLE?.[r.handle]?.[0] ?? r.handle : null, kind: r.kind },
      action: r.action,
      entityType: r.entityType,
      entityCode: r.entityCode,
      ms: r.ms,
      edition: system ? `${system.pack ?? system.code} ${D?.PACKS?.[system.id]?.v ?? ''}`.trim() : null,
      requestId: r.kind === 'user' ? `req-${(total - i).toString(16).padStart(8, '0')}` : null,
      sourceIp: r.kind === 'user' ? '172.31.250.10' : null,
      before: r.before,
      after: r.after,
      full: true,
    };
  });
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null): AuditTrailAdapter {
  const all = () => sampleEntries(getD());
  const day = (iso: string) => iso.slice(0, 10);
  const orgSlug = () => getOrg() ?? 'sample';
  return {
    sample: true,
    async list(query, page, pageSize) {
      const rows = all()
        .filter((e) => (query.ms ? e.ms === query.ms : true))
        .filter((e) => (!query.from || day(e.occurredAt) >= query.from) && (!query.to || day(e.occurredAt) <= query.to))
        .map((e) => (query.ms ? e : { ...e, entityCode: null, before: undefined, after: undefined, full: false }));
      return { ok: true, data: { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length } };
    },
    async exportCsv(ms) {
      const head = ['seq', 'occurred_at', 'actor_handle', 'actor_name', 'actor_kind', 'action', 'entity_type', 'entity_code', 'ms', 'before', 'after'];
      const rows = all().filter((e) => e.ms === ms).sort((a, b) => a.seq - b.seq)
        .map((e) => [e.seq, e.occurredAt, e.actor.handle, e.actor.displayName, e.actor.kind, e.action, e.entityType, e.entityCode, e.ms, e.before ?? null, e.after ?? null]);
      const text = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
      return { ok: true, data: textFile(text, `audit-trail-${ms}-${getD()?.TODAY_S ?? 'sample'}.csv`, 'text/csv;charset=utf-8') };
    },
    async verify() {
      const entries = all();
      return { ok: true, data: [
        { chain: `org_${orgSlug()}.audit_trail`, checked: entries.filter((e) => e.ms).length, firstBrokenSeq: null, anchorOk: true },
        { chain: 'platform.audit_log', checked: entries.filter((e) => !e.ms).length, firstBrokenSeq: null, anchorOk: true },
      ] };
    },
    async anchors() {
      const entries = all();
      const today = getD()?.TODAY_S ?? '2026-09-29';
      const line = (chain: string, seq: number) => JSON.stringify({
        chain, seq, rowHash: 'ab'.repeat(32), anchoredAt: `${today}T04:00:00Z`, installationId: '00000000-0000-4000-8000-000000000000', keyId: 'sample-key', signature: 'sample, not signed',
      });
      const text = `${[line(`org_${orgSlug()}.audit_trail`, entries[0]?.seq ?? 0), line('platform.audit_log', entries.length)].join('\n')}\n`;
      return { ok: true, data: textFile(text, `audit-anchors-${today}.ndjson`, 'application/x-ndjson') };
    },
  };
}
