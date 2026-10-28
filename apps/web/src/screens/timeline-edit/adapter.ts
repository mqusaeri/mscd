// The adapter of the build (C.6): the api's routes when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise. The
// value is written out in full so Vite replaces it and drops the other branch; the sample adapter comes through a
// dynamic import, so an api build holds no sample code (R-13). Unit tests create both adapters directly.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { TimelineAdapter } from './model';

const METHODS = [
  'cycles', 'eventDetail', 'createEvent', 'updateEvent', 'activities', 'generate', 'updateActivity', 'startCycle', 'recordCertificate', 'transition',
  'markDone', 'updateItem',
] as const satisfies readonly (keyof TimelineAdapter)[];

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<TimelineAdapter>, sample = true): TimelineAdapter {
  let pending: Promise<TimelineAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { sample };
  for (const name of METHODS) {
    out[name] = (...args: unknown[]) => get().then((a) => (a[name] as unknown as (...x: unknown[]) => unknown)(...args));
  }
  return out as unknown as TimelineAdapter;
}

// The adapters read the snapshot, the data source and the organisation of the latest render.
const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: TimelineAdapter } | null = null;

/** The adapter of the build for this session (one per client or sample data source). */
export function adapterFor(ctx: HostContext): TimelineAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : ctx.ds;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client, () => env.ctx?.D ?? null)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter({
          getD: () => env.ctx?.D ?? null,
          getDs: () => env.ctx?.ds ?? null,
          getOrg: () => env.ctx?.org?.id ?? null,
        }))),
    };
  }
  return cached.adapter;
}
