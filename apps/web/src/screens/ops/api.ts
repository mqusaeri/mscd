// API adapter of the operator console through the host's client (R-17). The diagnostics archive is binary, which the
// client reads as text, so that one request goes through `fetch` with the client's CSRF token and language (handoff
// deviation 6, until the client offers a binary answer). A 401 of that request reads the health through the client,
// so the client's session-ended path (the sign-in page) runs as for any other request.
import type { CommandResult, JobRunResponse, OpsHealth, OpsOrganizationCreateResult, OpsOrganizationItem, PackSummary, QueueStats } from '@mscd/shared';
import { toApiError } from '../../data/api/ApiClient';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { NO_CLIENT, call } from '../api';
import type { Page } from '../api';
import type { Health, OpsAdapter, OrgItem, PackItem, Result } from './model';
import { ROUTES } from './routes';

const fail = <T,>(res: ApiResult<unknown> & { ok: false }): Result<T> => ({ ok: false, error: res.error });
const pair = (m: unknown): [string, string] | null => (Array.isArray(m) && m.length === 2 ? [String(m[0]), String(m[1])] : null);

export function fromHealth(h: OpsHealth): Health {
  return {
    components: h.components.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
    migrations: h.migrations.map((m) => ({ schema: m.schema, latest: m.latest, expected: m.expected })),
    queues: h.queues.map((q) => ({ ...q })),
    licences: h.licences.map((l) => ({ org: l.org, state: l.state, validUntil: l.validUntil })),
  };
}

export function fromOrg(o: OpsOrganizationItem): OrgItem {
  return {
    slug: o.slug, name: o.name, status: o.status, licence: o.licence ? { state: o.licence.state, validUntil: o.licence.validUntil } : null,
    memberCount: o.memberCount, systemCount: o.systemCount, plan: o.plan, createdAt: o.createdAt,
  };
}

export function fromPack(p: PackSummary): PackItem {
  return { packId: p.packId, version: p.version, frameworkCode: p.frameworkCode, edition: p.edition, status: p.status, preRelease: p.preRelease, installedAt: p.installedAt };
}

/** The file name of a `Content-Disposition` header, or undefined. */
export function fileNameOf(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=(?:UTF-8'[^']*')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* the plain name below */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : undefined;
}

export function createApiAdapter(client: ApiClient | null, fetchImpl: typeof fetch | null = typeof fetch === 'function' ? fetch : null): OpsAdapter {
  return {
    async health() {
      const res = await call<OpsHealth>(client, ROUTES.health);
      return res.ok ? { ok: true, data: fromHealth(res.data) } : fail(res);
    },
    async queues() {
      const res = await call<QueueStats[]>(client, ROUTES.queues);
      return res.ok ? { ok: true, data: res.data.map((q) => ({ ...q })) } : fail(res);
    },
    async runJob(name, org) {
      const res = await call<JobRunResponse>(client, ROUTES.jobRun, { params: { name }, body: org ? { org } : {} });
      return res.ok ? { ok: true, data: res.data.jobId } : fail(res);
    },
    async diagnostics() {
      if (!client || !fetchImpl) return { ok: false, error: { status: 0, message: NO_CLIENT } };
      const headers: Record<string, string> = { Accept: 'application/gzip, application/problem+json', 'Accept-Language': client.language };
      if (client.csrfToken) headers['X-CSRF-Token'] = client.csrfToken;
      let response: Response;
      try {
        response = await fetchImpl.call(globalThis, ROUTES.diagnostics[1], { method: 'POST', credentials: 'same-origin', headers });
      } catch {
        return { ok: false, error: { status: 0, message: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] } };
      }
      if (!response.ok) {
        let body: unknown;
        try {
          const text = await response.text();
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        // The session ended: a request through the client lets it tell its listeners, which show the sign-in page.
        if (response.status === 401) await call(client, ROUTES.health);
        return { ok: false, error: toApiError(response.status, body, response.headers) };
      }
      const blob = await response.blob();
      return { ok: true, data: { blob, fileName: fileNameOf(response.headers.get('content-disposition')) ?? 'mscd-diagnostics.tar.gz' } };
    },
    async organizations({ page, pageSize, q }) {
      const res = await call<Page<OpsOrganizationItem>>(client, ROUTES.orgList, { query: { page, pageSize, ...(q ? { q } : {}) } });
      if (!res.ok) return fail(res);
      return { ok: true, data: { items: res.data.items.map(fromOrg), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
    async createOrganization(body, idempotencyKey) {
      const res = await call<OpsOrganizationCreateResult>(client, ROUTES.orgCreate, { body, idempotencyKey });
      if (!res.ok) return fail(res);
      const data = res.data.data;
      return {
        ok: true,
        data: { slug: data.slug, invitationSent: data.invitationSent, invitationUrl: data.invitationUrl ?? null, message: pair(res.data.message) },
      };
    },
    async installLicence(org, licence) {
      const res = await call(client, ROUTES.licensePut, { body: { org, licence } });
      return res.ok ? { ok: true, data: null } : fail(res);
    },
    async packs() {
      const res = await call<PackSummary[]>(client, ROUTES.packsList);
      return res.ok ? { ok: true, data: res.data.map(fromPack) } : fail(res);
    },
    async importPack(file, fileName, idempotencyKey) {
      const form = new FormData();
      form.append('bundle', file, fileName);
      const res = await call<CommandResult & { data?: { packId?: string; version?: string; status?: string } }>(client, ROUTES.packsImport, { body: form, idempotencyKey });
      if (!res.ok) return fail(res);
      const data = res.data.data ?? {};
      return {
        ok: true,
        data: { packId: String(data.packId ?? ''), version: String(data.version ?? ''), status: data.status === 'unchanged' ? 'unchanged' : 'queued', message: pair(res.data.message) },
      };
    },
    async resetMfa(email, reason) {
      const res = await call(client, ROUTES.resetMfa, { body: { email, reason } });
      return res.ok ? { ok: true, data: null } : fail(res);
    },
  };
}
