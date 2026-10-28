// API adapter of the repository administration (MILESTONE-2 M2-09): the storage routes of D.2 through the host's
// client (R-17). The licence (`license.get`, Tenant Admin) and the system list (`admin.ms.list`, Tenant Admin) are
// read only when the session holds their permissions; a Storage Admin gets every wizard adapter (the server checks
// the licence on create) and the systems of the snapshot.
import type { CommandResult, LicenceView, ManagementSystemView, RepositoryTestResult, RepositoryView } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { AdapterCode, ConnectionCode, ModeCode, OwnershipCode } from './labels';
import type { AdminData, RepoModel, StorageAdminAdapter, SystemRef, TestOutcome } from './model';
import { ROUTES } from './routes';

/** What the API adapter may read besides the repositories. */
export interface ApiReadScope {
  /** `license.read`: the licensed adapters are offered, else every wizard adapter. */
  licence: boolean;
  /** `ms.admin`: the systems come from `admin.ms.list`, else from `fallbackSystems`. */
  systems: boolean;
  fallbackSystems: SystemRef[];
  orgId: string | null;
}

const pair = (t: unknown): [string, string] | null => {
  if (Array.isArray(t) && t.length === 2) return [String(t[0]), String(t[1])];
  if (typeof t === 'string') return [t, t];
  return null;
};

/** The administration model of a `RepositoryView` (D.2). */
export function fromView(view: RepositoryView): RepoModel {
  return {
    ref: view.ref,
    slug: view.id,
    name: view.name,
    adapter: view.adapter as AdapterCode,
    modes: [...view.modes] as ModeCode[],
    ownershipType: view.ownershipType as OwnershipCode,
    connectionStatus: view.connectionStatus as ConnectionCode,
    message: view.msg ? pair(view.msg) : null,
    summary: Array.isArray(view.tenant) ? [view.tenant[0], view.tenant[1]] : String(view.tenant),
    systems: [...view.ms],
    last: view.last,
    retentionConfirmed: view.retentionConfirmed,
    metadataMinimization: view.metadataMinimization,
    readOnly: view.readOnly,
    credentialSet: view.credentialSet,
    credentialExpiresAt: view.credentialExpiresAt,
    config: { ...view.config },
    actions: [...view.actions],
  };
}

/** `RepositoryTestResult` from the `data` of the test command. */
export function testOf(result: CommandResult & { data?: RepositoryTestResult }): TestOutcome {
  const d = result.data;
  return {
    status: (d?.status ?? 'failed') as ConnectionCode,
    permissions: d ? [...d.permissions] : [],
    references: d?.references ?? 0,
    nextCheckAt: d?.nextCheckAt ?? null,
    message: pair(d?.message ?? result.message) ?? ['-', '-'],
  };
}

export function createApiAdapter(client: ApiClient | null, scope: ApiReadScope): StorageAdminAdapter {
  return {
    async load() {
      const [repos, licence, systems] = await Promise.all([
        call<RepositoryView[]>(client, ROUTES.reposList),
        scope.licence ? call<LicenceView>(client, ROUTES.licenseGet) : Promise.resolve(null),
        scope.systems ? call<ManagementSystemView[]>(client, ROUTES.msList) : Promise.resolve(null),
      ]);
      if (!repos.ok) return { ok: false, error: repos.error };
      const data: AdminData = {
        repos: repos.data.map(fromView),
        licensed: licence && licence.ok ? (licence.data.storageAdapters as AdapterCode[]) : null,
        systems: systems && systems.ok
          ? systems.data.filter((m) => m.status !== 'archived').map((m) => ({ slug: m.slug, code: m.code }))
          : scope.fallbackSystems,
        orgId: scope.orgId,
      };
      return { ok: true, data };
    },
    async create(body, idempotencyKey) {
      const res = await call<RepositoryView>(client, ROUTES.reposCreate, { body, idempotencyKey });
      return res.ok ? { ok: true, data: fromView(res.data) } : { ok: false, error: res.error };
    },
    async update(ref, body) {
      const res = await call<RepositoryView>(client, ROUTES.reposUpdate, { params: { id: ref }, body });
      return res.ok ? { ok: true, data: fromView(res.data) } : { ok: false, error: res.error };
    },
    async setCredential(ref, body) {
      const res = await call<null>(client, ROUTES.reposCredentials, { params: { id: ref }, body });
      return res.ok ? { ok: true, data: null } : { ok: false, error: res.error };
    },
    async test(ref) {
      const res = await call<CommandResult & { data?: RepositoryTestResult }>(client, ROUTES.reposTest, { params: { id: ref } });
      return res.ok ? { ok: true, data: testOf(res.data) } : { ok: false, error: res.error };
    },
    async consent(ref) {
      const res = await call<CommandResult>(client, ROUTES.reposReauthorize, { params: { id: ref } });
      if (!res.ok) return { ok: false, error: res.error };
      const message = pair(res.data.message) ?? undefined;
      return { ok: true, data: { redirectUrl: res.data.redirectUrl ?? null }, ...(message ? { message } : {}) };
    },
  };
}
