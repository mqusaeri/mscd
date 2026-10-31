// The adapter of the build (MILESTONE-2 C.6): the api's routes when the build's `VITE_DATA_SOURCE` is `api`, the sample
// adapter otherwise, through a dynamic import so an api build holds no sample code (R-13).
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { ConfirmationsAdapter } from './model';
import { settled } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<ConfirmationsAdapter>): ConfirmationsAdapter {
  let pending: Promise<ConfirmationsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    sample: true,
    mine: () => settled(get().then((a) => a.mine())),
    open: (id) => settled(get().then((a) => a.open(id))),
    confirm: (id) => settled(get().then((a) => a.confirm(id))),
  };
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: ConfirmationsAdapter } | null = null;

/** The adapter of the build, bound to the latest host context. */
export function adapterFor(ctx: HostContext): ConfirmationsAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : 'sample';
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter({
          getD: () => env.ctx?.D ?? null,
          org: () => env.ctx?.org?.id ?? null,
          me: () => env.ctx?.me?.user.handle ?? env.ctx?.person.handle ?? '',
        }))),
    };
  }
  return cached.adapter;
}
