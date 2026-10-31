// The adapter of the build (C.6): the api's route when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise,
// through a dynamic import so an api build holds no sample code (R-13). Unit tests create both adapters directly.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { PendingTotalsAdapter } from './model';

/** An adapter that loads the real one on its first call (the sample adapter's chunk). */
export function deferredAdapter(load: () => Promise<PendingTotalsAdapter>): PendingTotalsAdapter {
  let pending: Promise<PendingTotalsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    sample: true,
    totals: (ms) => get().then((a) => a.totals(ms)),
  };
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: PendingTotalsAdapter } | null = null;

export function adapterFor(ctx: HostContext): PendingTotalsAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : ctx.ds;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(() => env.ctx?.D ?? null))),
    };
  }
  return cached.adapter;
}
