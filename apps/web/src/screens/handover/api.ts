// API adapter of the Handover screen (MILESTONE-2 M2-10): `GET /ms/{ms}/holdings/{handle}` and
// `POST /ms/{ms}/holdings/{handle}/reassign` through the host's client (R-17).
import type { CommandResult, Holdings, HoldingsReassign } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { HandoverAdapter, HoldingsModel, MoveOutcome } from './model';
import { ROUTES } from './routes';

export function fromHoldings(view: Holdings): HoldingsModel {
  return {
    handle: view.handle,
    ms: view.ms,
    items: view.items.map((i) => ({ kind: i.kind, code: i.code, title: i.title, dueAt: i.dueAt })),
    counts: { ...view.counts },
  };
}

/** The outcome of a move: its count, message, the warnings per record and the systems that changed. */
export function outcomeOf(result: CommandResult): MoveOutcome {
  return {
    count: typeof result.count === 'number' ? result.count : 0,
    message: Array.isArray(result.message) ? [String(result.message[0]), String(result.message[1])] : null,
    warnings: (result.warnings ?? []).map((w) => ({ rule: w.rule, text: [w.messages.en, w.messages.id] })),
    changed: [...result.changed],
  };
}

export function createApiAdapter(client: ApiClient | null): HandoverAdapter {
  return {
    async holdings(ms, handle) {
      const res = await call<Holdings>(client, ROUTES.holdings, { params: { ms, handle } });
      return res.ok ? { ok: true, data: fromHoldings(res.data) } : { ok: false, error: res.error };
    },
    async reassign(ms, handle, body: HoldingsReassign) {
      const res = await call<CommandResult>(client, ROUTES.reassign, { params: { ms, handle }, body });
      return res.ok ? { ok: true, data: outcomeOf(res.data) } : { ok: false, error: res.error };
    },
  };
}
