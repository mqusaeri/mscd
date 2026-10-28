// The adapter of the build for "Findings and actions" and the findings parts of the Internal audit screen
// (MILESTONE-2 C.6, M2-14): the api's routes when the build's `VITE_DATA_SOURCE` is `api`, the sample registers
// otherwise, loaded through a dynamic import so an api build holds no sample code or data (R-13).
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { FindingsAdapter } from './model';
import { deferred, meOf } from './shared';

const METHODS: readonly (keyof FindingsAdapter)[] = [
  'findings', 'raise', 'update', 'move', 'actions', 'createAction', 'updateAction', 'moveAction', 'selfAssessment', 'assess', 'raiseFromGap', 'targets', 'events',
];

/** The adapter of the build; `getCtx` gives the host context of the latest render (the sample persona can change). */
export function adapterFor(getCtx: () => HostContext): FindingsAdapter {
  if (import.meta.env.VITE_DATA_SOURCE === 'api') return createApiAdapter(getCtx().client, () => getCtx().org?.id ?? null);
  return deferred<FindingsAdapter>(
    () => import('./sample').then((m) => m.createSampleAdapter({ getD: () => getCtx().D, org: () => getCtx().org?.id ?? null, me: () => meOf(getCtx()) })),
    METHODS,
    { sample: true },
  );
}
