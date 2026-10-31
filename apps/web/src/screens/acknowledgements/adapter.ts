// The adapter of the build (MILESTONE-2 C.6): the api's routes when the build's `VITE_DATA_SOURCE` is `api`, the sample
// adapter otherwise, through a dynamic import so an api build holds no sample code (R-13). Unit tests create both
// adapters directly.
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import type { AcknowledgementsAdapter } from './model';
import { settled } from './model';

type AsyncMethod = Exclude<keyof AcknowledgementsAdapter, 'sample' | 'settingsOf' | 'documentId' | 'evidenceId'>;
const METHODS: readonly AsyncMethod[] = ['list', 'get', 'ask', 'remind', 'close', 'exportCsv', 'saveSettings'];

/**
 * An adapter whose module is loaded on first use; a failed load keeps the next call free to try again and answers
 * "Connection lost". The lookups that must answer at once read the loaded module, else nothing.
 */
export function deferredAdapter(load: () => Promise<AcknowledgementsAdapter>): AcknowledgementsAdapter {
  let pending: Promise<AcknowledgementsAdapter> | null = null;
  let ready: AcknowledgementsAdapter | null = null;
  const get = () => {
    pending ??= load().then((a) => (ready = a)).catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = {
    sample: true,
    settingsOf: (...args: Parameters<AcknowledgementsAdapter['settingsOf']>) => {
      void get().catch(() => undefined);
      return ready ? ready.settingsOf(...args) : null;
    },
    documentId: (...args: Parameters<AcknowledgementsAdapter['documentId']>) => (ready ? ready.documentId(...args) : args[1]),
    evidenceId: (...args: Parameters<AcknowledgementsAdapter['evidenceId']>) => (ready ? ready.evidenceId(...args) : args[1]),
  };
  for (const name of METHODS) {
    out[name] = (...args: unknown[]) => settled(get().then((a) => (a[name] as unknown as (...x: unknown[]) => Promise<never>)(...args)));
  }
  return out as unknown as AcknowledgementsAdapter;
}

const env: { ctx: HostContext | null } = { ctx: null };
let cached: { key: unknown; adapter: AcknowledgementsAdapter } | null = null;

/** The adapter of the build, bound to the latest host context (the snapshot changes after every reload). */
export function adapterFor(ctx: HostContext): AcknowledgementsAdapter {
  env.ctx = ctx;
  const api = import.meta.env.VITE_DATA_SOURCE === 'api';
  const key = api ? ctx.client : 'sample';
  if (!cached || cached.key !== key) {
    cached = {
      key,
      adapter: api
        ? createApiAdapter(ctx.client, () => env.ctx?.D ?? null, () => env.ctx?.org?.id ?? null)
        : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter({ getD: () => env.ctx?.D ?? null, org: () => env.ctx?.org?.id ?? null }))),
    };
  }
  return cached.adapter;
}
