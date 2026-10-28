// The adapter of the build for the Management review screen (MILESTONE-2 C.6, M2-14): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample reviews otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import { deferred } from '../findings/shared';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { ReviewAdapter } from './model';

const METHODS: readonly (keyof ReviewAdapter)[] = ['list', 'create', 'update', 'putInput', 'move'];

/** The adapter of the build; `getCtx` gives the host context of the latest render. */
export function adapterFor(getCtx: () => HostContext): ReviewAdapter {
  if (import.meta.env.VITE_DATA_SOURCE === 'api') return createApiAdapter(getCtx().client);
  return deferred<ReviewAdapter>(
    () => import('./sample').then((m) => m.createSampleAdapter({ getD: () => getCtx().D, org: () => getCtx().org?.id ?? null })),
    METHODS,
    { sample: true },
  );
}
