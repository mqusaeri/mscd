// API adapter of the Organisation screen: `GET /admin/organization` and `PATCH /admin/organization` with `If-Match`
// through the host's client (R-17).
import type { OrganizationSettings } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { Loaded, OrgAdapter, OrgSettings } from './model';
import { ROUTES } from './routes';

export function fromWire(view: OrganizationSettings): OrgSettings {
  return {
    slug: view.slug,
    name: view.name,
    timeZone: view.timeZone,
    siteCount: view.siteCount,
    localLogin: view.localLogin,
    installationId: view.installationId,
    tenancyMode: view.tenancyMode,
    activeAdminCount: view.activeAdminCount,
    etag: view.etag,
  };
}

/** `GET /admin/organization` as the screen's model. */
export async function loadOrganization(client: ApiClient | null): Promise<Loaded> {
  const res = await call<OrganizationSettings>(client, ROUTES.get);
  return res.ok ? { ok: true, settings: fromWire(res.data) } : { ok: false, error: res.error };
}

export function createApiAdapter(client: ApiClient | null): OrgAdapter {
  return {
    load: () => loadOrganization(client),
    async save(patch, etag) {
      const res = await call(client, ROUTES.update, { body: patch, ifMatch: etag });
      if (!res.ok) return { ok: false, error: res.error };
      return loadOrganization(client);
    },
  };
}
