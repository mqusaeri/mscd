// The adapter of the build for the evidence forms (MILESTONE-2 C.6, M2-11): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample snapshot otherwise, with the sample adapter loaded through a dynamic import so
// an API build holds no sample code (R-13). Every call is settled: it answers a Result and never rejects.
import { deferred, settled } from '../controls-edit/common';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { ADAPTER_METHODS } from './model';
import type { EvidenceAdapter } from './model';

export function settle(adapter: EvidenceAdapter): EvidenceAdapter {
  const out: Record<string, unknown> = {};
  for (const name of ADAPTER_METHODS) {
    out[name] = (...args: unknown[]) => settled((adapter[name] as (...x: unknown[]) => Promise<never>)(...args));
  }
  return out as unknown as EvidenceAdapter;
}

export function adapterFor(ctx: Pick<HostContext, 'client' | 'ds' | 'D'>, getD: () => HostContext['D'] = () => ctx.D): EvidenceAdapter {
  return settle(import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(ctx.client)
    : deferred<EvidenceAdapter>(() => import('./sample').then((m) => m.createSampleAdapter(getD, ctx.ds)), ADAPTER_METHODS));
}
