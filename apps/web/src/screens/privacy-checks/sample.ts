// Sample adapter of Personal data checks (MILESTONE-3 M3-04): the checks of the sample store of
// ../privacy-requests/sample-store.ts for the selected system, their mentions, and "Mark checked" with the server's
// rules (a check of a closed request or a check already done is refused). Nothing leaves the browser.
import type { ApiResult } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import type { TextPair } from '../types';
import { isOpen } from '../privacy-requests/model';
import { requestsOf } from '../privacy-requests/sample-store';
import type { CheckRow, PrivacyChecksAdapter } from './model';
import { sortChecks } from './model';

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });
const refuse = <T,>(status: number, message: TextPair, messageKey?: string): ApiResult<T> => ({
  ok: false, status, error: { status, message: [message[0], message[1]], ...(messageKey ? { messageKey } : {}) },
});

const R = {
  notFound: ['No such personal data check in this system.', 'Pemeriksaan data pribadi tidak ditemukan di sistem ini.'] as TextPair,
  closed: ['The request of this check is closed.', 'Permintaan dari pemeriksaan ini sudah ditutup.'] as TextPair,
  done: ['This check is already done.', 'Pemeriksaan ini sudah selesai.'] as TextPair,
};

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null, me: () => { handle: string; displayName: string }): PrivacyChecksAdapter {
  const requests = () => requestsOf(getD(), getOrg() ?? 'ndt');
  const find = (ms: string, id: string) => {
    for (const r of requests()) {
      const check = r.checks.find((c) => c.id === id && c.ms === ms);
      if (check) return { request: r, check };
    }
    return null;
  };
  return {
    sample: true,
    async list(ms) {
      const rows: CheckRow[] = [];
      for (const r of requests()) {
        for (const c of r.checks) {
          if (c.ms !== ms || (!isOpen(r.status) && c.status !== 'done')) continue;
          rows.push({ id: c.id, requestNo: r.requestNo, type: r.type, subject: { name: r.subject.name, handle: r.subject.kind === 'member' ? r.subjectHandle : null }, dueAt: r.dueAt, status: c.status, doneAt: c.doneAt });
        }
      }
      return ok(sortChecks(rows));
    },
    async mentions(ms, id) {
      const found = find(ms, id);
      if (!found) return refuse(404, R.notFound);
      return ok({ items: (found.request.mentions[ms] ?? []).map((m) => ({ ...m })), truncated: false });
    },
    async done(ms, id, note) {
      const found = find(ms, id);
      if (!found) return refuse(404, R.notFound);
      if (!isOpen(found.request.status)) return refuse(409, R.closed, 'privacy.check_closed');
      if (found.check.status === 'done') return refuse(409, R.done, 'privacy.check_done');
      found.check.status = 'done';
      found.check.doneBy = me();
      found.check.doneAt = new Date().toISOString();
      found.check.note = note;
      return ok({ message: null });
    },
  };
}
