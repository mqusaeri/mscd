// The adapter of the build for the activity forms (MILESTONE-2 C.6, M2-11): the api's route when the build's
// `VITE_DATA_SOURCE` is `api`, the sample data source otherwise, with the sample adapter loaded through a dynamic import
// so an API build holds no sample code (R-13). Every call is settled: it answers a Result and never rejects.
import { deferred, settled } from '../controls-edit/common';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { ADAPTER_METHODS } from './model';
import type { ActivityAdapter } from './model';

export function settle(adapter: ActivityAdapter): ActivityAdapter {
  return {
    start: (activity) => settled(adapter.start(activity)),
    block: (activity, gate, reason) => settled(adapter.block(activity, gate, reason)),
  };
}

export function adapterFor(ctx: Pick<HostContext, 'client' | 'ds' | 'D'>): ActivityAdapter {
  return settle(import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client)
    : deferred<ActivityAdapter>(() => import('./sample').then((m) => m.createSampleAdapter(ctx.ds)), ADAPTER_METHODS));
}
