// The adapter of the build for the My account screen (MILESTONE-2 C.6): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample account otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import { createApiAdapter } from './api';
import type { AccountAdapter, Result } from './model';
import { TEXT } from './text';

const LOST = <T,>(): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } });

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<AccountAdapter>): AccountAdapter {
  let pending: Promise<AccountAdapter> | null = null;
  let loaded: AccountAdapter | null = null;
  const get = () => {
    pending ??= load().then((a) => (loaded = a), (e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const settled = <T,>(p: Promise<Result<T>>) => p.catch(() => LOST<T>());
  return {
    security: () => settled(get().then((a) => a.security())),
    providers: (org) => get().then((a) => a.providers(org), () => []),
    changePassword: (c, n) => settled(get().then((a) => a.changePassword(c, n))),
    recoveryCodes: (code) => settled(get().then((a) => a.recoveryCodes(code))),
    savePreferences: (p) => settled(get().then((a) => a.savePreferences(p))),
    linkIdentity: (slug) => settled(get().then((a) => a.linkIdentity(slug))),
    revokeCalendarFeed: (ms) => settled(get().then((a) => a.revokeCalendarFeed(ms))),
    // Synchronous: the module is loaded by the first read of the page.
    replaceAuthenticator: () => (loaded ? loaded.replaceAuthenticator() : { ok: false, error: { status: 0, message: [TEXT.sampleOnly[0], TEXT.sampleOnly[1]] } }),
    personEmail: (name) => get().then((a) => a.personEmail(name), () => null),
  };
}

export function adapterFor(client: ApiClient | null): AccountAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter()));
}
