// The adapter of the build (C.6): the api's routes when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise,
// through a dynamic import so an api build holds no sample code (R-13). Unit tests create both adapters directly.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { PrivacyChecksAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<PrivacyChecksAdapter>): PrivacyChecksAdapter {
  let pending: Promise<PrivacyChecksAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    sample: true,
    list: (ms) => get().then((a) => a.list(ms)),
    mentions: (ms, id) => get().then((a) => a.mentions(ms, id)),
    done: (ms, id, note) => get().then((a) => a.done(ms, id, note)),
  };
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: PrivacyChecksAdapter } | null = null;

export function adapterFor(ctx: HostContext): PrivacyChecksAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : ctx.ds;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(
          () => env.ctx?.D ?? null,
          () => env.ctx?.org?.id ?? null,
          () => ({ handle: env.ctx?.person.handle ?? 'rina', displayName: env.ctx?.person.name ?? 'Rina Kusuma' }),
        ))),
    };
  }
  return cached.adapter;
}
