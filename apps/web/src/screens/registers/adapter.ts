// The adapter of the build for the Registers screen (MILESTONE-2 C.6, M2-13): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample registers otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { meOf } from './model';
import type { RegistersAdapter, Result } from './model';

/** A failed promise (a module that did not load, a network error) as an error result, so a form never hangs. */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } as ApiError }));
}

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<RegistersAdapter>, sample: boolean): RegistersAdapter {
  let pending: Promise<RegistersAdapter> | null = null;
  let loaded: RegistersAdapter | null = null;
  const get = () => {
    pending ??= load().then(
      (a) => {
        loaded = a;
        return a;
      },
      (e: unknown) => {
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  return {
    sample,
    list: (ms, kind, query) => get().then((a) => a.list(ms, kind, query)),
    create: (ms, kind, body, key) => get().then((a) => a.create(ms, kind, body, key)),
    update: (ms, kind, row, patch) => get().then((a) => a.update(ms, kind, row, patch)),
    recordValue: (ms, row, body, key) => get().then((a) => a.recordValue(ms, row, body, key)),
    treatments: (ms, risk) => get().then((a) => a.treatments(ms, risk)),
    addTreatment: (ms, risk, body, key) => get().then((a) => a.addTreatment(ms, risk, body, key)),
    moveTreatment: (ms, risk, t, to) => get().then((a) => a.moveTreatment(ms, risk, t, to)),
    acceptResidual: (ms, risk, body, key) => get().then((a) => a.acceptResidual(ms, risk, body, key)),
    link: (ms, kind, row, target, note) => get().then((a) => a.link(ms, kind, row, target, note)),
    targets: (ms) => get().then((a) => a.targets(ms)),
    treatmentCodes: (ms) => get().then((a) => a.treatmentCodes(ms)),
    // Synchronous: the screen asks once the list has loaded, so the module is there by then.
    proofHolders: (ms) => (loaded ? loaded.proofHolders(ms) : []),
    attachProof: (ms, holder, file) => get().then((a) => a.attachProof(ms, holder, file)),
    openProof: (ms, row) => get().then((a) => a.openProof(ms, row)),
  };
}

/** The adapter of the build; `getCtx` gives the host context of the latest render (the sample persona can change). */
export function adapterFor(getCtx: () => HostContext): RegistersAdapter {
  const ctx = getCtx();
  if (import.meta.env.VITE_DATA_SOURCE === 'api') {
    return createApiAdapter(ctx.client, { getD: () => getCtx().D, me: () => meOf(getCtx()), org: () => getCtx().org?.id ?? '' });
  }
  return deferredAdapter(
    () => import('./sample').then((m) => m.createSampleAdapter({
      getD: () => getCtx().D,
      me: () => meOf(getCtx()),
      role: () => getCtx().role,
      ds: () => getCtx().ds,
    })),
    true,
  );
}
