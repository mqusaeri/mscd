// The adapter of the build for the repository administration (MILESTONE-2 C.6, M2-09): the api's routes when the
// build's `VITE_DATA_SOURCE` is `api`, the sample repositories otherwise. The value is written out in full so Vite
// replaces it and drops the other branch; the sample adapter comes through a dynamic import, so an api build holds no
// sample code or data (R-13). This module is loaded only by the lazy chunks of the screen and of the layer drawers.
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { ApiReadScope } from './api';
import type { Result, StorageAdminAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<StorageAdminAdapter>): StorageAdminAdapter {
  let pending: Promise<StorageAdminAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    load: () => get().then((a) => a.load()),
    create: (body, key) => get().then((a) => a.create(body, key)),
    update: (ref, body) => get().then((a) => a.update(ref, body)),
    setCredential: (ref, body) => get().then((a) => a.setCredential(ref, body)),
    test: (ref) => get().then((a) => a.test(ref)),
    consent: (ref) => get().then((a) => a.consent(ref)),
  };
}

/** A call of an adapter that never rejects: a failed module load or network error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** What the API adapter may read besides the repositories, from the session's permissions. */
export function readScopeOf(ctx: HostContext): ApiReadScope {
  return {
    licence: ctx.orgCan('license.read'),
    systems: ctx.orgCan('ms.admin'),
    fallbackSystems: (ctx.D?.MS ?? []).map((m) => ({ slug: m.id, code: m.short })),
    orgId: ctx.me?.org?.id ?? null,
  };
}

export function adapterFor(ctx: HostContext, getD: () => ControllerData | null): StorageAdminAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client, readScopeOf(ctx))
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD, ctx.org?.id ?? null)));
}
