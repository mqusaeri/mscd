// The adapter of the build (MILESTONE-2 C.6), as the Licence screen chooses it: the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample adapter otherwise. The value is written out in full so Vite replaces it and
// drops the other branch; the sample adapter comes through a dynamic import, so an api build holds no sample code
// (R-13). Unit tests call `createApiAdapter` and `createSampleAdapter` directly.
import { useMemo, useRef } from 'react';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData, DataSource } from '../../data/types';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { docOf, meOf, settled } from './model';
import type { DocsAdapter, Result } from './model';

type AsyncMethods = Exclude<keyof DocsAdapter, 'recordId'>;
const METHODS: readonly AsyncMethods[] = ['create', 'update', 'transition', 'assign', 'addVersion', 'versions', 'openFile', 'templates'];

/**
 * An adapter whose module is loaded on first use; a failed load keeps the next call free to try again, and every call
 * answers a result (a failed load becomes "Connection lost") instead of rejecting.
 */
export function deferredAdapter(load: () => Promise<DocsAdapter>, recordId: DocsAdapter['recordId']): DocsAdapter {
  let pending: Promise<DocsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { recordId };
  for (const name of METHODS) {
    out[name] = (...args: unknown[]) =>
      settled(get().then((a) => (a[name] as unknown as (...x: unknown[]) => Promise<Result<unknown>>)(...args)));
  }
  return out as unknown as DocsAdapter;
}

export function adapterFor(client: ApiClient | null, ds: DataSource | null, getD: () => ControllerData | null, me: () => string): DocsAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client, getD)
    : deferredAdapter(
        () => import('./sample').then((m) => m.createSampleAdapter(getD, ds, me)),
        (ms, code) => (docOf(getD(), ms, code) ? code : null),
      );
}

/** The adapter of a component, bound to the latest host context (the snapshot changes after every reload). */
export function useDocsAdapter(ctx: HostContext): DocsAdapter {
  const latest = useRef(ctx);
  latest.current = ctx;
  return useMemo(
    () => adapterFor(ctx.client, ctx.ds, () => latest.current.D, () => meOf(latest.current)),
    [ctx.client, ctx.ds],
  );
}
