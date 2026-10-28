// The adapter of the build for the Company sign-in screen (MILESTONE-2 C.6, M2-10): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample providers otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import { createApiAdapter } from './api';
import type { IdpAdapter, Result } from './model';

/** A call that never rejects: a failed module load or a thrown error becomes a connection error. */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<IdpAdapter>): IdpAdapter {
  let pending: Promise<IdpAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    list: () => get().then((a) => a.list()),
    create: (body, key) => get().then((a) => a.create(body, key)),
    update: (id, patch) => get().then((a) => a.update(id, patch)),
    test: (id) => get().then((a) => a.test(id)),
    policy: () => get().then((a) => a.policy()),
    setPolicy: (policy, etag) => get().then((a) => a.setPolicy(policy, etag)),
  };
}

export function adapterFor(client: ApiClient | null): IdpAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter()));
}
