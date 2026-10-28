// API adapter of the controls and requirements forms (MILESTONE-2 M2-11): the routes of D.1 and D.2 through the host's
// client (R-17). Entries are addressed by the uuid of their snapshot ref and sent with its ETag (`If-Match`, D.1).
import type { ApplicabilityTargetItem, CommandResult, DocumentItem, Page, RegisterItem } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { outcomeOf, refusal } from './common';
import type { Result } from './common';
import type { ControlsAdapter, DocChoice, EntryRef, RiskChoice, TargetItem } from './model';
import { ROUTES } from './routes';
import { TEXT } from './text';

/** Pages read at most from a list route (200 rows each). */
const MAX_PAGES = 25;

/** Every row of a paged list route, or the error of the first page that failed. */
async function allPages<T>(client: ApiClient | null, route: (typeof ROUTES)['registers' | 'documents'], params: Record<string, string>): Promise<Result<T[]>> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await call<Page<T>>(client, route, { params, query: { page, pageSize: 200 } });
    if (!res.ok) return { ok: false, error: res.error };
    rows.push(...res.data.items);
    if (rows.length >= res.data.total || !res.data.items.length) break;
  }
  return { ok: true, data: rows };
}

const needsUuid = (entry: EntryRef) => (entry.uuid ? null : refusal(404, TEXT.notFound));

export function createApiAdapter(client: ApiClient | null): ControlsAdapter {
  return {
    async targets(ms) {
      // Retired rows too, so an existing entry on one shows "No longer in the standard"; the Add form leaves them out.
      const res = await call<ApplicabilityTargetItem[]>(client, ROUTES.targets, { params: { ms }, query: { retired: 'true' } });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: res.data.map((t): TargetItem => ({ ...t })) };
    },
    async create(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.create, { params: { ms }, body, idempotencyKey }));
    },
    async update(entry, patch) {
      const missing = needsUuid(entry);
      if (missing) return missing;
      return outcomeOf(await call<CommandResult>(client, ROUTES.update, { params: { ms: entry.ms, id: entry.uuid! }, body: patch, ifMatch: entry.etag }));
    },
    async criteria(entry, body) {
      const missing = needsUuid(entry);
      if (missing) return missing;
      return outcomeOf(await call<CommandResult>(client, ROUTES.criteria, { params: { ms: entry.ms, id: entry.uuid! }, body }));
    },
    async transition(entry, body) {
      const missing = needsUuid(entry);
      if (missing) return missing;
      return outcomeOf(await call<CommandResult>(client, ROUTES.transition, { params: { ms: entry.ms, id: entry.uuid! }, body, ifMatch: entry.etag }));
    },
    async remove(entry, reason, confirm) {
      const missing = needsUuid(entry);
      if (missing) return missing;
      const body = confirm ? { reason: reason.trim(), confirm: true } : { reason: reason.trim() };
      return outcomeOf(await call<CommandResult>(client, ROUTES.remove, {
        params: { ms: entry.ms, entityType: 'applicability_entry', id: entry.uuid! }, body,
      }));
    },
    async risks(ms) {
      const res = await allPages<RegisterItem>(client, ROUTES.registers, { ms, register: 'risks' });
      if (!res.ok) return res;
      return { ok: true, data: res.data.map((r): RiskChoice => ({ code: r.code, title: r.title })) };
    },
    async documents(ms) {
      const res = await allPages<DocumentItem>(client, ROUTES.documents, { ms });
      if (!res.ok) return res;
      return { ok: true, data: res.data.map((d): DocChoice => ({ code: d.id, title: d.title, implements: [...d.requirements] })) };
    },
  };
}
