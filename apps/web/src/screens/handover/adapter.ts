// The adapter of the build for the Handover screen (MILESTONE-2 C.6, M2-10): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample records otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { HandoverAdapter, Result } from './model';

/** A call that never rejects: a failed module load or a thrown error becomes a connection error. */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<HandoverAdapter>): HandoverAdapter {
  let pending: Promise<HandoverAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    holdings: (ms, handle) => get().then((a) => a.holdings(ms, handle)),
    reassign: (ms, handle, body) => get().then((a) => a.reassign(ms, handle, body)),
  };
}

/** The adapter of the build; `getCtx` gives the host context of the latest render. */
export function adapterFor(getCtx: () => HostContext): HandoverAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(getCtx().client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(() => getCtx().D, () => getCtx().ds)));
}
