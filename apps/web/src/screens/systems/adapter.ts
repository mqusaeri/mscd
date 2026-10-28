// The adapter of the build for the Management systems screen (MILESTONE-2 C.6, M2-09): the api's routes when the
// build's `VITE_DATA_SOURCE` is `api`, the sample systems otherwise, loaded through a dynamic import so an api build
// holds no sample code or data (R-13).
import type { ControllerData } from '../../data/types';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { SystemsAdapter } from './model';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<SystemsAdapter>): SystemsAdapter {
  let pending: Promise<SystemsAdapter> | null = null;
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
  };
}

export function adapterFor(ctx: HostContext, getD: () => ControllerData | null): SystemsAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client, { users: ctx.orgCan('user.manage') })
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
}
