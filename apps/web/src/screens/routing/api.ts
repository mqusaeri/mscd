// API adapter of the Routing rules screen (MILESTONE-2 M2-09): the routing and storage object routes of D.2 through
// the host's client (R-17). Repositories come from `admin.storage.repositories.list` (the same read permission as the
// rules), the systems from `admin.ms.list` when the session is a Tenant Admin, else from the snapshot.
import type { CommandResult, ManagementSystemView, Page, RepositoryView, RoutingRuleView, StorageObjectMeta } from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { call } from '../api';
import type { AdapterCode, LinkStatusCode, ModeCode } from '../storage-admin/labels';
import type { ApprovalCode, ObjectModel, RepoChoice, RoutingAdapter, RuleModel, RuleOutcome, SystemRef } from './model';
import { ROUTES } from './routes';

export interface RoutingReadScope {
  /** `ms.admin`: the systems come from `admin.ms.list`, else from `fallbackSystems`. */
  systems: boolean;
  fallbackSystems: SystemRef[];
}

export function fromRuleView(view: RoutingRuleView): RuleModel {
  return {
    id: view.id,
    ms: view.ms,
    classification: view.classification,
    objectKind: view.objectKind,
    repository: view.repository,
    mode: view.mode as ModeCode,
    priority: view.priority,
    note: view.note,
    approvalStatus: view.approvalStatus as ApprovalCode,
    requestedBy: view.requestedBy,
    approvedBy: view.approvedBy,
    createdAt: view.createdAt,
  };
}

export function repoChoiceOf(view: RepositoryView): RepoChoice {
  const roots: Record<string, string> = {};
  const raw = view.config?.roots;
  if (raw && typeof raw === 'object') {
    for (const [ms, value] of Object.entries(raw as Record<string, { path?: unknown }>)) {
      if (value && typeof value.path === 'string') roots[ms] = value.path;
    }
  }
  return { slug: view.id, name: view.name, adapter: view.adapter as AdapterCode, modes: [...view.modes] as ModeCode[], readOnly: view.readOnly, roots };
}

export function fromObjectMeta(meta: StorageObjectMeta): ObjectModel {
  return {
    id: meta.id,
    repository: meta.repository,
    displayName: meta.displayName,
    folderPath: meta.folderPath,
    sizeBytes: meta.sizeBytes,
    mimeType: meta.mimeType,
    hashAlgorithm: meta.hashAlgorithm,
    hashSource: meta.hashSource,
    linkStatus: meta.linkStatus as LinkStatusCode,
    lastVerifiedAt: meta.lastVerifiedAt,
  };
}

/** The outcome of a rule command: its message and `data.approvalStatus`. */
export function outcomeOf(result: CommandResult): RuleOutcome {
  const data = (result as CommandResult & { data?: { approvalStatus?: string } }).data;
  const message = Array.isArray(result.message) ? ([result.message[0], result.message[1]] as [string, string]) : null;
  return { message, approvalStatus: (data?.approvalStatus as ApprovalCode | undefined) ?? null, changed: [...result.changed] };
}

export function createApiAdapter(client: ApiClient | null, scope: RoutingReadScope): RoutingAdapter {
  const command = async (run: Promise<ApiResult<CommandResult>>) => {
    const res = await run;
    return res.ok ? { ok: true as const, data: outcomeOf(res.data) } : { ok: false as const, error: res.error };
  };
  return {
    async load() {
      const [rules, repos, systems] = await Promise.all([
        call<RoutingRuleView[]>(client, ROUTES.rulesList),
        call<RepositoryView[]>(client, ROUTES.reposList),
        scope.systems ? call<ManagementSystemView[]>(client, ROUTES.msList) : Promise.resolve(null),
      ]);
      if (!rules.ok) return { ok: false, error: rules.error };
      if (!repos.ok) return { ok: false, error: repos.error };
      return {
        ok: true,
        data: {
          rules: rules.data.map(fromRuleView),
          repos: repos.data.map(repoChoiceOf),
          systems: systems && systems.ok ? systems.data.filter((m) => m.status !== 'archived').map((m) => ({ slug: m.slug, code: m.code })) : scope.fallbackSystems,
        },
      };
    },
    create: (body, idempotencyKey) => command(call<CommandResult>(client, ROUTES.rulesCreate, { body, idempotencyKey })),
    update: (id, body) => command(call<CommandResult>(client, ROUTES.rulesUpdate, { params: { id }, body })),
    approve: (id) => command(call<CommandResult>(client, ROUTES.rulesApprove, { params: { id } })),
    reject: (id) => command(call<CommandResult>(client, ROUTES.rulesReject, { params: { id } })),
    async objects(query) {
      const res = await call<Page<StorageObjectMeta>>(client, ROUTES.objectsList, {
        query: { page: query.page, pageSize: query.pageSize, repository: query.repository, status: query.status },
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { items: res.data.items.map(fromObjectMeta), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
  };
}
