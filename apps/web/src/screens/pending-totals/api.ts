// API adapter of the Open work totals screen (MILESTONE-3 M3-08, D.10) through the host's client (R-17): the counts
// per chain stage and business role of one system, `GET /ms/{ms}/audit/pending?aggregate=unit`
// (`readmodel.audit.pending` with `audit.pending.aggregate`). The answer holds no names (product decision 2); `toRows`
// keeps only the four fields of `PendingAggregate`, and an answer of another shape shows as a failure.
import type { ApiClient } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import { call } from '../api';
import { toRows } from './model';
import type { PendingTotalsAdapter, Result, TotalsRow } from './model';
import { ROUTES } from './routes';
import { TEXT } from './text';

export function createApiAdapter(client: ApiClient | null): PendingTotalsAdapter {
  return {
    sample: false,
    async totals(ms: MsId): Promise<Result<TotalsRow[]>> {
      const res = await call<unknown>(client, ROUTES.pending, { params: { ms }, query: { aggregate: 'unit' } });
      if (!res.ok) return { ok: false, error: res.error };
      const rows = toRows(res.data);
      if (!rows) return { ok: false, error: { status: res.status, message: [TEXT.unexpected[0], TEXT.unexpected[1]] } };
      return { ok: true, data: rows };
    },
  };
}
