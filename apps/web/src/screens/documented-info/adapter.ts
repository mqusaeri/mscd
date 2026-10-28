// The adapter of the build (MILESTONE-2 C.6), as the Licence screen chooses it: the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample rows otherwise, loaded through a dynamic import so an api build holds no
// sample code (R-13). Unit tests call `createApiAdapter` and `createSampleAdapter` directly.
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { docOf, settled } from '../docs-edit/model';
import { createApiAdapter } from './api';
import type { DiAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load answers "Connection lost" and the next call retries. */
export function deferredAdapter(load: () => Promise<DiAdapter>, documentId: DiAdapter['documentId']): DiAdapter {
  let pending: Promise<DiAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    list: (ms) => settled(get().then((a) => a.list(ms))),
    link: (ms, code, id) => settled(get().then((a) => a.link(ms, code, id))),
    documentId,
  };
}

export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null): DiAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client, getD)
    : deferredAdapter(
        () => import('./sample').then((m) => m.createSampleAdapter(getD)),
        (ms, code) => (docOf(getD(), ms, code) ? code : null),
      );
}
