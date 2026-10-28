// API adapters of the Management systems screen and the edition transition drawer (MILESTONE-2 M2-09): the routes of
// D.2 through the host's client (R-17). The primary MS Manager of each system comes from the members list
// (`admin.users.list`, the same Tenant Admin who holds `ms.admin`), read page by page.
import type {
  CommandResult, ManagementSystemView, PackSummary, Page, RepositoryView, UserView,
} from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { primaryManagers } from './model';
import type { MsStatusCode, PackChoice, SystemModel, SystemsAdapter, TransitionAdapter } from './model';
import { ROUTES } from './routes';

/** Pages of members read at most (200 each): beyond that the manager column says "Not shown". */
const MAX_USER_PAGES = 25;

export function fromSystemView(view: ManagementSystemView, managers?: Map<string, string> | null): SystemModel {
  return {
    id: view.id,
    slug: view.slug,
    code: view.code,
    name: view.name,
    frameworkCode: view.frameworkCode,
    frameworkName: view.frameworkName,
    edition: view.edition,
    packId: view.packId,
    packVersion: view.packVersion,
    transitionTargetEdition: view.transitionTargetEdition,
    status: view.status as MsStatusCode,
    scopeStatement: view.scopeStatement,
    certificationBody: view.certificationBody,
    color: view.color,
    defaultRepository: view.defaultRepository,
    ...(managers ? { primaryManager: managers.get(view.slug) ?? null } : {}),
  };
}

export function fromPack(pack: PackSummary): PackChoice {
  return { packId: pack.packId, version: pack.version, frameworkCode: pack.frameworkCode, edition: pack.edition, status: pack.status, preRelease: pack.preRelease };
}

/** Every member of the organisation, page by page; null when the list could not be read. */
async function allUsers(client: ApiClient | null): Promise<UserView[] | null> {
  const users: UserView[] = [];
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const res = await call<Page<UserView>>(client, ROUTES.usersList, { query: { page, pageSize: 200 } });
    if (!res.ok) return null;
    users.push(...res.data.items);
    if (users.length >= res.data.total || !res.data.items.length) return users;
  }
  return null;
}

export function createApiAdapter(client: ApiClient | null, options: { users: boolean }): SystemsAdapter {
  let managers: Map<string, string> | null = null;
  return {
    async load() {
      const [systems, packs, repos, users] = await Promise.all([
        call<ManagementSystemView[]>(client, ROUTES.msList),
        call<PackSummary[]>(client, ROUTES.packsList),
        call<RepositoryView[]>(client, ROUTES.reposList),
        options.users ? allUsers(client) : Promise.resolve(null),
      ]);
      if (!systems.ok) return { ok: false, error: systems.error };
      managers = users ? primaryManagers(users) : null;
      return {
        ok: true,
        data: {
          systems: systems.data.map((s) => fromSystemView(s, managers)),
          packs: packs.ok ? packs.data.map(fromPack) : [],
          repos: repos.ok ? repos.data.map((r) => ({ slug: r.id, name: r.name })) : [],
        },
      };
    },
    async create(body, idempotencyKey) {
      const res = await call<ManagementSystemView>(client, ROUTES.msCreate, { body, idempotencyKey });
      return res.ok ? { ok: true, data: fromSystemView(res.data, managers ?? new Map()) } : { ok: false, error: res.error };
    },
    async update(id, body) {
      const res = await call<ManagementSystemView>(client, ROUTES.msUpdate, { params: { id }, body });
      return res.ok ? { ok: true, data: fromSystemView(res.data, managers) } : { ok: false, error: res.error };
    },
  };
}

export function createTransitionAdapter(client: ApiClient | null, options: { statuses: boolean } = { statuses: false }): TransitionAdapter {
  return {
    async packs() {
      const res = await call<PackSummary[]>(client, ROUTES.packsList);
      return res.ok ? { ok: true, data: res.data.map(fromPack) } : { ok: false, error: res.error };
    },
    async statuses() {
      if (!options.statuses) return null;
      const res = await call<ManagementSystemView[]>(client, ROUTES.msList);
      return res.ok ? Object.fromEntries(res.data.map((m) => [m.slug, m.status as MsStatusCode])) : null;
    },
    async transition(ms, body) {
      const res = await call<CommandResult>(client, ROUTES.msTransition, { params: { ms }, body });
      if (!res.ok) return { ok: false, error: res.error };
      const message = Array.isArray(res.data.message) ? ([res.data.message[0], res.data.message[1]] as [string, string]) : undefined;
      return { ok: true, data: { changed: [...res.data.changed] }, ...(message ? { message } : {}) };
    },
  };
}
