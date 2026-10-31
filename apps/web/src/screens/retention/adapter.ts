// The adapter of the build (C.6): the api's routes when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise,
// through a dynamic import so an api build holds no sample code (R-13). Unit tests create both adapters directly.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { RetentionAdapter } from './model';

const METHODS = [
  'rules', 'putRule', 'reviews', 'decide', 'approve', 'reject', 'fileRemoved', 'register', 'exportCsv', 'holds', 'createHold', 'releaseHold',
] as const satisfies readonly (keyof RetentionAdapter)[];

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<RetentionAdapter>): RetentionAdapter {
  let pending: Promise<RetentionAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { sample: true };
  for (const name of METHODS) out[name] = (...args: unknown[]) => get().then((a) => (a[name] as unknown as (...x: unknown[]) => unknown)(...args));
  return out as unknown as RetentionAdapter;
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: RetentionAdapter } | null = null;

export function adapterFor(ctx: HostContext): RetentionAdapter {
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
          () => env.ctx?.person?.handle ?? 'rina',
        ))),
    };
  }
  return cached.adapter;
}
