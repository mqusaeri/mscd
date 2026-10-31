// The adapter of the build (C.6): the api's routes when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise,
// through a dynamic import so an api build holds no sample code (R-13). Unit tests create both adapters directly.
// Shared by Access reviews and Access review of this system.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { AccessReviewsAdapter } from './model';

const METHODS = [
  'settings', 'putSettings', 'list', 'create', 'get', 'decide', 'apply', 'complete', 'cancel', 'report', 'msList', 'msGet', 'msDecide', 'msApply', 'signOff',
] as const satisfies readonly (keyof AccessReviewsAdapter)[];

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<AccessReviewsAdapter>, evidence: AccessReviewsAdapter['evidence']): AccessReviewsAdapter {
  let pending: Promise<AccessReviewsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { sample: true, evidence };
  for (const name of METHODS) out[name] = (...args: unknown[]) => get().then((a) => (a[name] as unknown as (...x: unknown[]) => unknown)(...args));
  return out as unknown as AccessReviewsAdapter;
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: AccessReviewsAdapter } | null = null;

/** The evidence items of a system in the sample snapshot, by code (the sample's ids are the codes). */
function sampleEvidence(ms: string) {
  const evs = env.ctx?.D?.bundles?.[ms]?.evs ?? [];
  return evs.map((e) => ({ id: e.code, code: e.code, title: e.title })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

export function adapterFor(ctx: HostContext): AccessReviewsAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : ctx.ds;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client, () => env.ctx?.D ?? null)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(
          () => env.ctx?.D ?? null,
          () => env.ctx?.org?.id ?? null,
          () => env.ctx?.person?.handle ?? 'rina',
        )), sampleEvidence),
    };
  }
  return cached.adapter;
}
