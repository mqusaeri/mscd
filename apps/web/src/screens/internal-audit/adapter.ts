// The adapter of the build for the Internal audit screen (MILESTONE-2 C.6, M2-14): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample internal audits otherwise, loaded through a dynamic import so an api build
// holds no sample code or data (R-13).
import { deferred, meOf } from '../findings/shared';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { InternalAuditAdapter } from './model';

const METHODS: readonly (keyof InternalAuditAdapter)[] = [
  'cycles', 'programme', 'plan', 'detail', 'activities', 'generate', 'updateActivity', 'updateEvent', 'records', 'registerRecord', 'addFile', 'targets',
];

/** The adapter of the build; `getCtx` gives the host context of the latest render (the sample persona can change). */
export function adapterFor(getCtx: () => HostContext): InternalAuditAdapter {
  if (import.meta.env.VITE_DATA_SOURCE === 'api') return createApiAdapter(getCtx().client, () => getCtx().D);
  return deferred<InternalAuditAdapter>(
    () => import('./sample').then((m) => m.createSampleAdapter({
      getD: () => getCtx().D,
      org: () => getCtx().org?.id ?? null,
      me: () => meOf(getCtx()),
      lang: () => getCtx().lang,
    })),
    METHODS,
    { sample: true },
  );
}
