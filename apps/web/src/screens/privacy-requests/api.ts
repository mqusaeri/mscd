// API adapter of Personal data requests (MILESTONE-3 M3-04, D.1, D.6) through the host's client (R-17): the register (one
// page of 200, filtered on the server by status and type and by the search text), the members of the organisation for
// the subject picker (`admin.users.list`, every page, invited and disabled members included as the server accepts them),
// recording a request with an Idempotency-Key, one request, the moves with `If-Match`, the actions of each type, and the
// state of a queued person export.
import type { BackgroundTask, CommandResult, Page, PrivacyRequestDetail, PrivacyRequestItem, UserView } from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { call, newIdempotencyKey } from '../api';
import type { TextPair } from '../types';
import type { ExportState, Member, Outcome, PrivacyRequestsAdapter, RequestDetail, RequestRow } from './model';
import { ROUTES } from './routes';

/** Page size of the member list (the largest the server allows) and the most pages read (10 000 members). */
const MEMBER_PAGE_SIZE = 200;
const MEMBER_PAGES = 50;

export const fromItem = (r: PrivacyRequestItem): RequestRow => ({
  id: r.id, requestNo: r.requestNo, type: r.type, status: r.status, subject: { ...r.subject }, channel: r.channel, receivedAt: r.receivedAt, dueAt: r.dueAt,
  closedAt: r.closedAt, handledBy: r.handledBy, overdue: r.overdue, etag: r.etag,
});

export const fromDetail = (d: PrivacyRequestDetail): RequestDetail => ({
  ...fromItem(d), note: d.note, identityCheckNote: d.identityCheckNote, identityCheckedBy: d.identityCheckedBy, outcome: d.outcome, result: d.result,
  checks: d.checks.map((c) => ({ ...c })), actions: d.actions.map((a) => ({ ...a })), exportTaskId: d.exportTaskId,
});

/** The message pair of a command result. */
export function messageOf(result: CommandResult): TextPair | null {
  const m = result.message;
  return Array.isArray(m) && m.length === 2 ? [m[0], m[1]] : null;
}

const outcome = (res: ApiResult<CommandResult>): ApiResult<Outcome> =>
  res.ok ? { ok: true, status: res.status, data: { message: messageOf(res.data), ...(res.data.taskId ? { taskId: res.data.taskId } : {}) } } : res;

export function createApiAdapter(client: ApiClient | null): PrivacyRequestsAdapter {
  return {
    async list(filter) {
      const query: Record<string, string | number> = { pageSize: 200 };
      if (filter.status && filter.status !== 'open') query.status = filter.status;
      if (filter.type) query.type = filter.type;
      if (filter.q.trim()) query.q = filter.q.trim();
      const res = await call<Page<PrivacyRequestItem>>(client, ROUTES.list, { query });
      if (!res.ok) return res;
      const rows = res.data.items.map(fromItem);
      return { ok: true, status: res.status, data: filter.status === 'open' ? rows.filter((r) => r.status === 'received' || r.status === 'in_progress') : rows };
    },
    async members() {
      // Every page of the member list (200 per page), so the picker offers each member of a large organisation.
      const members: Member[] = [];
      let status = 200;
      for (let page = 1; page <= MEMBER_PAGES; page += 1) {
        const res = await call<Page<UserView>>(client, ROUTES.members, { query: { page, pageSize: MEMBER_PAGE_SIZE } });
        if (!res.ok) return res;
        status = res.status;
        for (const u of res.data.items) {
          if (u.kind !== 'system') members.push({ id: u.id, handle: u.handle, name: u.displayName, email: u.email });
        }
        if (res.data.items.length < MEMBER_PAGE_SIZE || page * MEMBER_PAGE_SIZE >= res.data.total) break;
      }
      return { ok: true, status, data: members };
    },
    async create(input) {
      const res = await call<CommandResult>(client, ROUTES.create, { body: input, idempotencyKey: newIdempotencyKey() });
      if (!res.ok) return res;
      const data = (res.data.data ?? {}) as { id?: string; requestNo?: string };
      return { ok: true, status: res.status, data: { id: data.id ?? res.data.ref?.id ?? '', requestNo: data.requestNo ?? res.data.ref?.code ?? '' } };
    },
    async get(id) {
      const res = await call<PrivacyRequestDetail>(client, ROUTES.get, { params: { id } });
      return res.ok ? { ok: true, status: res.status, data: fromDetail(res.data) } : res;
    },
    async update(id, patch, etag) {
      return outcome(await call<CommandResult>(client, ROUTES.update, { params: { id }, body: patch, ifMatch: etag }));
    },
    async rectify(id, body) {
      return outcome(await call<CommandResult>(client, ROUTES.rectify, { params: { id }, body }));
    },
    async restrict(id) {
      return outcome(await call<CommandResult>(client, ROUTES.restrict, { params: { id } }));
    },
    async erase(id) {
      return outcome(await call<CommandResult>(client, ROUTES.erase, { params: { id }, body: { confirm: true } }));
    },
    async close(id, text) {
      return outcome(await call<CommandResult>(client, ROUTES.close, { params: { id }, body: { outcome: text } }));
    },
    async exportPerson(id) {
      return outcome(await call<CommandResult>(client, ROUTES.exportPerson, { params: { id }, idempotencyKey: newIdempotencyKey() }));
    },
    async exportState(taskId) {
      const res = await call<BackgroundTask>(client, ROUTES.exportState, { params: { taskId } });
      if (!res.ok) return res;
      const state: ExportState = { status: res.data.status as ExportState['status'], downloadUrl: res.data.downloadUrl ?? null };
      return { ok: true, status: res.status, data: state };
    },
  };
}
