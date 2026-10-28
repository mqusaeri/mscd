// API adapter of the Audit trail screen (MILESTONE-2 M2-15) through the host's client (R-17): the entries of a system
// or the organisation's metadata (`audit-trail.list`, by date range, newest first), the CSV of a system
// (`audit-trail.export`, formula-neutralised by the api, F.15), the chain verification (`audit-trail.verify`) and the
// signed anchors as NDJSON (`audit-trail.anchors`). The files come back as text and are saved by the browser, so a
// refusal (429 after ten exports an hour) shows its message instead of a broken file.
import type { AuditChainVerifyResult, AuditEntry, AuditEntryMeta, Page } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { textFile } from '../auditor-access/shared';
import type { AuditTrailAdapter, EntryModel } from './model';
import { ROUTES } from './routes';

/** An entry of the list; `full` when the query named the system (the api answers metadata only for the organisation). */
export function fromEntry(e: AuditEntry | AuditEntryMeta, i: number, full = 'entityCode' in e || 'before' in e || 'after' in e): EntryModel {
  const x = e as Partial<AuditEntry> & AuditEntryMeta;
  return {
    key: `${e.seq}-${e.occurredAt}-${i}`,
    seq: e.seq,
    occurredAt: e.occurredAt,
    actor: { handle: e.actor.handle, displayName: e.actor.displayName, kind: e.actor.kind },
    action: e.action,
    entityType: e.entityType,
    entityCode: x.entityCode ?? null,
    ms: e.ms ?? null,
    edition: e.edition ?? null,
    requestId: e.requestId ?? null,
    sourceIp: e.sourceIp ?? null,
    before: x.before,
    after: x.after,
    full,
  };
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function createApiAdapter(client: ApiClient | null): AuditTrailAdapter {
  return {
    sample: false,
    async list(query, page, pageSize) {
      const res = await call<Page<AuditEntry | AuditEntryMeta>>(client, ROUTES.list, {
        query: { ms: query.ms ?? undefined, from: query.from ?? undefined, to: query.to ?? undefined, page, pageSize },
      });
      if (!res.ok) return { ok: false, error: res.error };
      const offset = (page - 1) * pageSize;
      return { ok: true, data: { items: res.data.items.map((e, i) => fromEntry(e, offset + i, query.ms !== null)), total: res.data.total } };
    },
    async exportCsv(ms) {
      const res = await call<string>(client, ROUTES.export, { query: { ms, format: 'csv' } });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: textFile(typeof res.data === 'string' ? res.data : '', `audit-trail-${ms}-${stamp()}.csv`, 'text/csv;charset=utf-8') };
    },
    async verify() {
      const res = await call<AuditChainVerifyResult[]>(client, ROUTES.verify);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: res.data.map((r) => ({ chain: r.chain, checked: r.checked, firstBrokenSeq: r.firstBrokenSeq ?? null, anchorOk: r.anchorOk })) };
    },
    async anchors(from, to) {
      const res = await call<string>(client, ROUTES.anchors, { query: { from: from ?? undefined, to: to ?? undefined } });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: textFile(typeof res.data === 'string' ? res.data : '', `audit-anchors-${stamp()}.ndjson`, 'application/x-ndjson') };
    },
  };
}
