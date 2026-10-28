// The adapter of the build for the notification bell (MILESTONE-2 C.6): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample notifications otherwise, loaded through a dynamic import so an api build
// holds no sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { createApiAdapter } from './api';
import type { NotificationsAdapter, Result } from './model';

/** An adapter whose module is loaded on first use; a failed load answers a connection error and tries again later. */
export function deferredAdapter(load: () => Promise<NotificationsAdapter>): NotificationsAdapter {
  let pending: Promise<NotificationsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const settled = <T,>(p: Promise<Result<T>>): Promise<Result<T>> => p.catch(() => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
  return {
    unreadCount: () => settled(get().then((a) => a.unreadCount())),
    list: (q) => settled(get().then((a) => a.list(q))),
    markRead: (id) => settled(get().then((a) => a.markRead(id))),
    markAllRead: () => settled(get().then((a) => a.markAllRead())),
  };
}

export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null): NotificationsAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
}
