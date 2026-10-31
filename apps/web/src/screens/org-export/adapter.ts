// The adapter of the build (C.6): the api's routes when `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise,
// through a dynamic import so an api build holds no sample code (R-13). Unit tests create both adapters directly.
// Shared by Organisation export and its banner in the host layer.
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { OrgExportAdapter, Result } from './model';

const METHODS = ['lifecycle', 'list', 'get', 'create', 'decide', 'partFile', 'manifestFile'] as const satisfies readonly (keyof OrgExportAdapter)[];

/** An adapter whose module is loaded on first use; a failed load answers a connection error and tries again later. */
export function deferredAdapter(load: () => Promise<OrgExportAdapter>): OrgExportAdapter {
  let pending: Promise<OrgExportAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { sample: true };
  for (const name of METHODS) {
    out[name] = (...args: unknown[]) => get()
      .then((a) => (a[name] as unknown as (...x: unknown[]) => Promise<Result<unknown>>)(...args))
      .catch((): Result<unknown> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
  }
  return out as unknown as OrgExportAdapter;
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: OrgExportAdapter } | null = null;

export function adapterFor(ctx: HostContext): OrgExportAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : 'sample';
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(
          () => env.ctx?.D ?? null,
          () => env.ctx?.org?.id ?? null,
          () => ({ handle: env.ctx?.person.handle ?? 'rina', name: env.ctx?.person.name ?? 'Rina Kusuma' }),
        ))),
    };
  }
  return cached.adapter;
}
