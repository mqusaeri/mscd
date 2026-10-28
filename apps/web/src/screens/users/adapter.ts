// The adapter of the build for the People and roles screen (MILESTONE-2 C.6, M2-10): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample people otherwise, loaded through a dynamic import so an api build holds no
// sample code or data (R-13). The Pending approvals screen uses the same adapter for its role grants.
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import type { HostContext } from '../types';
import { createApiAdapter } from './api';
import { selfOf } from './model';
import type { Result, UsersAdapter } from './model';

/** A call that never rejects: a failed module load or a thrown error becomes a connection error. */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<UsersAdapter>): UsersAdapter {
  let pending: Promise<UsersAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    members: () => get().then((a) => a.members()),
    systems: () => get().then((a) => a.systems()),
    providers: () => get().then((a) => a.providers()),
    org: () => get().then((a) => a.org()),
    invite: (body, key) => get().then((a) => a.invite(body, key)),
    update: (id, patch) => get().then((a) => a.update(id, patch)),
    grant: (system, body, key) => get().then((a) => a.grant(system, body, key)),
    approve: (system, id) => get().then((a) => a.approve(system, id)),
    reject: (system, id) => get().then((a) => a.reject(system, id)),
    revoke: (system, id) => get().then((a) => a.revoke(system, id)),
    holdings: (id) => get().then((a) => a.holdings(id)),
    registerIdentity: (id, body, key) => get().then((a) => a.registerIdentity(id, body, key)),
    resetMfa: (id) => get().then((a) => a.resetMfa(id)),
    history: (ids) => get().then((a) => a.history(ids)),
    currentGrant: (member, id) => get().then((a) => a.currentGrant(member, id)),
    renewSession: () => get().then((a) => a.renewSession()),
  };
}

/** The tenancy mode the organisation shows: multi tenancy for a SaaS organisation (D.2 `tenancyMode`). */
export function tenancyOf(ctx: HostContext): 'single' | 'multi' {
  return ctx.org?.deploy === 'saas' ? 'multi' : 'single';
}

/** The adapter of the build; `getCtx` gives the host context of the latest render (the sample persona can change). */
export function adapterFor(getCtx: () => HostContext): UsersAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(getCtx().client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(
      (): ControllerData | null => getCtx().D,
      () => selfOf(getCtx()).handle,
      () => tenancyOf(getCtx()),
    )));
}
