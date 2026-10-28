// The adapter of the build for the Organisation screen (MILESTONE-2 C.6): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample settings otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import type { Organisation } from '../../data/types';
import { createApiAdapter } from './api';
import type { Loaded, OrgAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<OrgAdapter>): OrgAdapter {
  let pending: Promise<OrgAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    load: () => get().then((a) => a.load()),
    save: (patch, etag) => get().then((a) => a.save(patch, etag)),
  };
}

export function adapterFor(client: ApiClient | null, getOrg: () => Organisation | null): OrgAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getOrg)));
}

/** A result that never rejects: a failed module load becomes a connection error. */
export function settle(promise: Promise<Loaded>): Promise<Loaded> {
  return promise.then((r) => r, (): Loaded => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}
