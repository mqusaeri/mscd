// API adapter of the Licence screen: `GET /license` and `PUT /admin/license` through the host's client (R-17).
import type { LicenceView } from '@mscd/shared';
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
  };
}
