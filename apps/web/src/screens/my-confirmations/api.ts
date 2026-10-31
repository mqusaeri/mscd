// API adapter of "Policies to confirm" (MILESTONE-3 M3-05, D.1, D.7) through the host's client (R-17): the caller's
// confirmations, the open of a version (a short-lived address of the api or of the provider) and the confirmation.
import type { CommandResult as WireResult, MyAcknowledgementItem, ObjectOpenResponse } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { Confirmation, ConfirmationsAdapter } from './model';
import { ROUTES } from './routes';
import { TEXT } from './text';

export function fromItem(i: MyAcknowledgementItem): Confirmation {
  return {
    id: i.id,
    requestId: i.requestId,
    ms: i.ms,
    document: { ...i.document },
    versionLabel: i.versionLabel,
    status: i.status,
    dueOn: i.dueOn,
    openedAt: i.openedAt,
    confirmedAt: i.confirmedAt,
    overdue: i.overdue,
  };
}

export function createApiAdapter(client: ApiClient | null): ConfirmationsAdapter {
  return {
    sample: false,
    async mine() {
      const res = await call<MyAcknowledgementItem[]>(client, ROUTES.mine);
      if (!res.ok) return { ok: false, error: res.error };
      if (!Array.isArray(res.data)) return { ok: false, error: { status: res.status, message: [TEXT.unexpected[0], TEXT.unexpected[1]] } };
      return { ok: true, data: res.data.map(fromItem) };
    },
    async open(id) {
      const res = await call<ObjectOpenResponse>(client, ROUTES.open, { params: { id } });
      return res.ok ? { ok: true, data: { url: res.data.url } } : { ok: false, error: res.error };
    },
    async confirm(id) {
      const res = await call<WireResult>(client, ROUTES.confirm, { params: { id } });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { message: res.data?.message ? [res.data.message[0], res.data.message[1]] : null, changed: [...(res.data?.changed ?? [])] } };
    },
  };
}
