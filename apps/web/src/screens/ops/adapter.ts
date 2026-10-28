// The adapter of the build for the operator console (MILESTONE-2 C.6): the api's routes when the build's
// `VITE_DATA_SOURCE` is `api`, the sample installation otherwise, loaded through a dynamic import so an api build holds
// no sample code or data (R-13).
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { createApiAdapter } from './api';
import type { OpsAdapter, Result } from './model';

/** An adapter whose module is loaded on first use; a failed load answers a connection error and tries again later. */
export function deferredAdapter(load: () => Promise<OpsAdapter>): OpsAdapter {
  let pending: Promise<OpsAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const settled = <T,>(p: Promise<Result<T>>): Promise<Result<T>> => p.catch(() => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
  return {
    health: () => settled(get().then((a) => a.health())),
    queues: () => settled(get().then((a) => a.queues())),
    runJob: (name, org) => settled(get().then((a) => a.runJob(name, org))),
    diagnostics: () => settled(get().then((a) => a.diagnostics())),
    organizations: (q) => settled(get().then((a) => a.organizations(q))),
    createOrganization: (body, key) => settled(get().then((a) => a.createOrganization(body, key))),
    organization: (slug) => settled(get().then((a) => a.organization(slug))),
    changeStatus: (slug, body) => settled(get().then((a) => a.changeStatus(slug, body))),
    events: (slug, page, pageSize) => settled(get().then((a) => a.events(slug, page, pageSize))),
    domains: (slug) => settled(get().then((a) => a.domains(slug))),
    addDomain: (slug, domain) => settled(get().then((a) => a.addDomain(slug, domain))),
    verifyDomain: (slug, domain) => settled(get().then((a) => a.verifyDomain(slug, domain))),
    removeDomain: (slug, domain) => settled(get().then((a) => a.removeDomain(slug, domain))),
    entitlement: (slug) => settled(get().then((a) => a.entitlement(slug))),
    setEntitlement: (slug, body, ifMatch) => settled(get().then((a) => a.setEntitlement(slug, body, ifMatch))),
    plans: () => settled(get().then((a) => a.plans())),
    installLicence: (org, licence) => settled(get().then((a) => a.installLicence(org, licence))),
    packs: () => settled(get().then((a) => a.packs())),
    importPack: (file, name, key) => settled(get().then((a) => a.importPack(file, name, key))),
    resetMfa: (email, reason) => settled(get().then((a) => a.resetMfa(email, reason))),
  };
}

export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null): OpsAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
}
