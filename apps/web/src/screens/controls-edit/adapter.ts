// The adapter of the build for the controls and requirements forms (MILESTONE-2 C.6, M2-11): the api's routes when
// the build's `VITE_DATA_SOURCE` is `api`, the sample snapshot otherwise. The value is written out in full so Vite
// replaces it and drops the other branch; the sample adapter comes through a dynamic import, so an API build holds no
// sample code (R-13). Every call is settled: it answers a Result and never rejects.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { deferred, settled } from './common';
import { ADAPTER_METHODS } from './model';
import type { ControlsAdapter } from './model';

/** Wraps every method so a failed module load or a thrown error answers "Connection lost". */
export function settle(adapter: ControlsAdapter): ControlsAdapter {
  const out: Record<string, unknown> = {};
  for (const name of ADAPTER_METHODS) {
    out[name] = (...args: unknown[]) => settled((adapter[name] as (...x: unknown[]) => Promise<never>)(...args));
  }
  return out as unknown as ControlsAdapter;
}

export function adapterFor(ctx: Pick<HostContext, 'client' | 'ds' | 'D'>, getD: () => HostContext['D'] = () => ctx.D): ControlsAdapter {
  return settle(import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client)
    : deferred<ControlsAdapter>(() => import('./sample').then((m) => m.createSampleAdapter(getD, ctx.ds)), ADAPTER_METHODS));
}
