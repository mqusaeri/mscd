// The adapter of the build for the Routing rules screen (MILESTONE-2 C.6, M2-09): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample rules otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import type { ControllerData } from '../../data/types';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { meOf } from './model';
import type { RoutingAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<RoutingAdapter>): RoutingAdapter {
  let pending: Promise<RoutingAdapter> | null = null;
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
    update: (id, body) => get().then((a) => a.update(id, body)),
    approve: (id) => get().then((a) => a.approve(id)),
    reject: (id) => get().then((a) => a.reject(id)),
    objects: (query) => get().then((a) => a.objects(query)),
  };
}

/** The adapter of the build; `getCtx` gives the host context of the latest render (the sample persona can change). */
export function adapterFor(getCtx: () => HostContext): RoutingAdapter {
  const ctx = getCtx();
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client, { systems: ctx.orgCan('ms.admin'), fallbackSystems: (ctx.D?.MS ?? []).map((m) => ({ slug: m.id, code: m.short })) })
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter((): ControllerData | null => getCtx().D, () => meOf(getCtx()))));
}
