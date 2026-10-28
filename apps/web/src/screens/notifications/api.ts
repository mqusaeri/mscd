// API adapter of the notification bell and panel: `GET /notifications`, `POST /notifications/{id}/read` and
// `POST /notifications/read-all` through the host's client (R-17).
import type { Notification } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { Page } from '../api';
import type { NotificationModel, NotificationsAdapter } from './model';
import { ROUTES } from './routes';

export function fromWire(n: Notification): NotificationModel {
  return {
    id: n.id,
    kind: n.kind,
    title: [n.title[0], n.title[1]],
    body: [n.body[0], n.body[1]],
    ms: n.ms ?? null,
    ref: n.ref ? { entityType: n.ref.entityType, id: n.ref.id, code: n.ref.code } : null,
    createdAt: n.createdAt,
    readAt: n.readAt,
  };
}

export function createApiAdapter(client: ApiClient | null): NotificationsAdapter {
  return {
    async unreadCount() {
      const res = await call<Page<Notification>>(client, ROUTES.list, { query: { unread: 'true', pageSize: 1 } });
      return res.ok ? { ok: true, data: res.data.total } : { ok: false, error: res.error };
    },
    async list({ page, pageSize, unreadOnly }) {
      const res = await call<Page<Notification>>(client, ROUTES.list, { query: { page, pageSize, ...(unreadOnly ? { unread: 'true' } : {}) } });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { items: res.data.items.map(fromWire), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
    async markRead(id) {
      const res = await call(client, ROUTES.read, { params: { id } });
      return res.ok ? { ok: true, data: null } : { ok: false, error: res.error };
    },
    async markAllRead() {
      const res = await call(client, ROUTES.readAll);
      return res.ok ? { ok: true, data: null } : { ok: false, error: res.error };
    },
  };
}
