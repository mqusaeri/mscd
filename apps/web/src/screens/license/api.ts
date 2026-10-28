// API adapter of the Licence screen: `GET /license`, `PUT /admin/license` and the installation id of
// `GET /admin/organization` (M2-16) through the host's client (R-17).
import type { LicenceView, OrganizationSettings } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { LicenceAdapter, LicenceModel } from './model';
import { ROUTES } from './routes';

/** The screen's model of the api's LicenceView (D.2). */
export function fromView(view: LicenceView): LicenceModel {
  const b = view.binding;
  return {
    licenseId: view.licenseId,
    organization: view.organization,
    state: view.state,
    validFrom: view.validFrom,
    validUntil: view.validUntil,
    graceDays: view.graceDays,
    binding: b.organizationId ? 'organization' : b.installationId ? 'installation' : b.trial ? 'trial' : null,
    users: { used: view.activeUsers, limit: view.maxUsers },
    systems: { used: view.managementSystems, limit: view.maxManagementSystems },
    frameworks: [...view.frameworks],
    storageAdapters: [...view.storageAdapters],
    features: [...view.features],
    signature: { alg: view.signature.alg, keyId: view.signature.keyId, verified: view.signature.verified },
    clockRollback: view.clockRollback,
    source: view.source ?? null,
    plan: view.plan ?? null,
  };
}

export function createApiAdapter(client: ApiClient | null): LicenceAdapter {
  return {
    async load() {
      const res = await call<LicenceView>(client, ROUTES.licenseGet);
      if (res.ok) return { ok: true, licence: fromView(res.data) };
      if (res.status === 404) return { ok: true, licence: null };
      return { ok: false, error: res.error };
    },
    async install(document) {
      const res = await call<LicenceView>(client, ROUTES.licensePut, { body: document });
      if (res.ok) return { ok: true, licence: fromView(res.data) };
      return { ok: false, error: res.error };
    },
    async installation() {
      const res = await call<OrganizationSettings>(client, ROUTES.organizationGet);
      return res.ok ? { installationId: res.data.installationId, tenancyMode: res.data.tenancyMode } : null;
    },
  };
}
