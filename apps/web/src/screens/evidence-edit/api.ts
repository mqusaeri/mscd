// API adapter of the evidence forms (MILESTONE-2 M2-11): the routes of D.1 and D.2 through the host's client (R-17).
// Evidence is addressed by the uuid of its snapshot ref (`<ms>:ev:<code>`) and changed with its ETag (`If-Match`).
//
// The targets of an evidence record come from the evidence list of the system (`readmodel.evidence.list`): its rows
// carry every live target with its id (`targets`) for readers who may change them. A row without them leaves the form
// with the first target of each system from the snapshot and the targets added in this session, whose ids
// `evidence.targets.create` answers.
import type { CommandResult, EvidenceItem, FreshnessThresholdItem, Page } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call, newIdempotencyKey } from '../api';
import { outcomeOf, refusal } from '../controls-edit/common';
import type { EvidenceAdapter, EvidenceRef, EvidenceTarget } from './model';
import { ROUTES } from './routes';
import { TEXT } from './text';

/** The targets of an evidence row when the server lists them (`{id, ms, targetType, code}`), else null. */
export function targetsOfRow(row: unknown): EvidenceTarget[] | null {
  const list = (row as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(list)) return null;
  const out: EvidenceTarget[] = [];
  for (const t of list as Record<string, unknown>[]) {
    const ms = typeof t.ms === 'string' ? t.ms : typeof t.system === 'string' ? t.system : null;
    const code = typeof t.code === 'string' ? t.code : null;
    const targetType = t.targetType === 'requirement' ? 'requirement' : t.targetType === 'catalogue_item' ? 'catalogue_item' : null;
    if (!ms || !code || !targetType) continue;
    out.push({ id: typeof t.id === 'string' ? t.id : null, ms, targetType, code });
  }
  return out;
}

const needsUuid = (ev: EvidenceRef) => (ev.uuid ? null : refusal(404, TEXT.notFound));

export function createApiAdapter(client: ApiClient | null): EvidenceAdapter {
  return {
    async create(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.create, { params: { ms }, body, idempotencyKey }));
    },
    async update(ev, patch) {
      const missing = needsUuid(ev);
      if (missing) return missing;
      return outcomeOf(await call<CommandResult>(client, ROUTES.update, { params: { ms: ev.ms, id: ev.uuid! }, body: patch, ifMatch: ev.etag }));
    },
    async addTarget(ev, body, idempotencyKey) {
      const missing = needsUuid(ev);
      if (missing) return missing;
      return outcomeOf(await call<CommandResult>(client, ROUTES.targetAdd, { params: { ms: ev.ms, id: ev.uuid! }, body, idempotencyKey }));
    },
    async removeTarget(ev, target, reason) {
      const missing = needsUuid(ev);
      if (missing) return missing;
      if (!target.id) return refusal(422, TEXT.noTargetId);
      return outcomeOf(await call<CommandResult>(client, ROUTES.targetRemove, { params: { ms: ev.ms, id: ev.uuid!, targetId: target.id }, body: { reason: reason.trim() } }));
    },
    async targets(ev) {
      const res = await call<Page<EvidenceItem>>(client, ROUTES.list, { params: { ms: ev.ms }, query: { q: ev.code, pageSize: 50 } });
      if (!res.ok) return { ok: false, error: res.error };
      const row = res.data.items.find((i) => i.code === ev.code);
      const listed = row ? targetsOfRow(row) : null;
      return { ok: true, data: listed ? { targets: listed, complete: true } : { targets: [], complete: false } };
    },
    async attach(ev, file, producedAt) {
      const missing = needsUuid(ev);
      if (missing) return missing;
      const body = file.source === 'link'
        ? { source: 'link', repository: file.repository, externalItemId: file.externalItemId, producedAt, mode: 'submit' }
        : { source: 'upload', uploadIntentId: file.uploadIntentId, producedAt, mode: 'submit' };
      return outcomeOf(await call<CommandResult>(client, ROUTES.files, { params: { ms: ev.ms, id: ev.uuid! }, body, idempotencyKey: newIdempotencyKey() }));
    },
    async thresholds(ms) {
      const res = await call<FreshnessThresholdItem[]>(client, ROUTES.thresholds, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map((t) => ({ ...t })) } : { ok: false, error: res.error };
    },
    async setThreshold(ms, frequencyCode, body) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.thresholdSet, { params: { ms, frequencyCode }, body }));
    },
  };
}
