// API adapter of Personal data checks (MILESTONE-3 M3-04, D.1, D.6.4) through the host's client (R-17): the checks of
// the system, the records that name the person of a check, and the check marked done.
import type { CommandResult, PrivacyCheckItem, PrivacyMentions } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { messageOf } from '../privacy-requests/api';
import type { CheckRow, PrivacyChecksAdapter } from './model';
import { ROUTES } from './routes';

export const fromItem = (c: PrivacyCheckItem): CheckRow => ({
  id: c.id, requestNo: c.requestNo, type: c.type, subject: { name: c.subject.name, handle: c.subject.handle }, dueAt: c.dueAt, status: c.status, doneAt: c.doneAt,
});

export function createApiAdapter(client: ApiClient | null): PrivacyChecksAdapter {
  return {
    async list(ms) {
      const res = await call<PrivacyCheckItem[]>(client, ROUTES.list, { params: { ms } });
      return res.ok ? { ok: true, status: res.status, data: res.data.map(fromItem) } : res;
    },
    async mentions(ms, id) {
      const res = await call<PrivacyMentions>(client, ROUTES.mentions, { params: { ms, id } });
      return res.ok ? { ok: true, status: res.status, data: { items: res.data.items.map((m) => ({ ...m })), truncated: res.data.truncated } } : res;
    },
    async done(ms, id, note) {
      const res = await call<CommandResult>(client, ROUTES.done, { params: { ms, id }, body: { note } });
      return res.ok ? { ok: true, status: res.status, data: { message: messageOf(res.data) } } : res;
    },
  };
}
