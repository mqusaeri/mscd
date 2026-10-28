// The adapter of the build for the Getting started screen (MILESTONE-2 C.6): the api's checklist when the build's
// `VITE_DATA_SOURCE` is `api`, the sample checklist otherwise, loaded through a dynamic import so an api build holds
// no sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { createApiAdapter } from './api';
import type { Loaded, OnboardingAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<OnboardingAdapter>): OnboardingAdapter {
  let pending: Promise<OnboardingAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return { load: () => get().then((a) => a.load()) };
}

export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null): OnboardingAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
}

/** Loads the checklist; never rejects (a failed module load becomes a connection error with Try again). */
export function loadSteps(adapter: OnboardingAdapter): Promise<Loaded> {
  return adapter.load().then(
    (res) => res,
    (): Loaded => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }),
  );
}
