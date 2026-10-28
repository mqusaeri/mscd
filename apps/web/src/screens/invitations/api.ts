// API adapter of the invitation banner: `POST /me/memberships/{org}/accept` (422 LIC-USERS when that organisation is
// at its licence user limit) and `POST /me/memberships/{org}/decline` through the host's client (R-17).
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { InvitationsAdapter } from './model';
import { ROUTES } from './routes';

export function createApiAdapter(client: ApiClient | null): InvitationsAdapter {
  return {
    async accept(org) {
      const res = await call(client, ROUTES.accept, { params: { org } });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    async decline(org) {
      const res = await call(client, ROUTES.decline, { params: { org } });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
  };
}
