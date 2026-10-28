// API adapter of the operator console through the host's client (R-17). The diagnostics archive is binary, which the
// client reads as text, so that one request goes through `fetch` with the client's CSRF token and language (M2-16
// handoff deviation 6, until the client offers a binary answer). A 401 of that request reads the health through the
// client, so the client's session-ended path (the sign-in page) runs as for any other request.
//
// The organisation lifecycle (M2-S12): detail, status and history (M2-S09), domains (M2-S11), entitlements and plans
// (M2-S10). The list item carries no user limit, so the list reads the detail of each organisation of the page (at
// most `DETAIL_READS` at a time) for it (M2-S12 handoff deviation 1). The client answers the body only, so the
// `If-Match` value of an entitlement change is built from the body (`entitlementEtag`, deviation 2).
import type {
  CommandResult, Entitlement as WireEntitlement, EntitlementSetResult, JobRunResponse, OpsHealth, OpsOrganizationCreateResult, OpsOrganizationDetail,
  OpsOrganizationItem, OrgDomain, OrgDomainAdded, OrgDomainCheck, OrganizationStatusChangeResult, OrganizationStatusEventItem, PackSummary,
  PlanPreset as WirePreset, QueueStats,
} from '@mscd/shared';
import { toApiError } from '../../data/api/ApiClient';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { NO_CLIENT, call } from '../api';
import type { Page } from '../api';
import type { Health, OpsAdapter, OrgItem, PackItem, Result } from './model';
import { entitlementEtag, mapLimited } from './org-model';
import type { Domain, DomainCheck, Entitlement, OrgDetail, PlanPreset, StatusEvent } from './org-model';
import { ROUTES } from './routes';

/** Detail reads of the organisation list in flight at once. */
export const DETAIL_READS = 4;

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

export function fromOrg(o: OpsOrganizationItem, maxUsers: number | null = null): OrgItem {
  return {
    slug: o.slug, name: o.name, status: o.status, licence: o.licence ? { state: o.licence.state, validUntil: o.licence.validUntil } : null,
    memberCount: o.memberCount, systemCount: o.systemCount, plan: o.plan, validUntil: o.validUntil, verifiedDomains: [...o.verifiedDomains],
    maxUsers, createdAt: o.createdAt,
  };
}

export function fromDetail(d: OpsOrganizationDetail): OrgDetail {
  return {
    slug: d.slug, name: d.name, status: d.status, region: d.region, createdAt: d.createdAt, memberCount: d.memberCount, systemCount: d.systemCount,
    entitlement: d.entitlement ? { ...d.entitlement } : null,
    domains: d.domains.map((x) => ({ domain: x.domain, status: x.status })),
    lastSignInAt: d.lastSignInAt,
  };
}

export function fromEvent(e: OrganizationStatusEventItem): StatusEvent {
  return { id: e.id, from: e.from, to: e.to, reason: e.reason, actor: e.actor ? { handle: e.actor.handle, displayName: e.actor.displayName } : null, at: e.at };
}

export function fromDomain(d: OrgDomain): Domain {
  return {
    domain: d.domain, status: d.status, method: d.method, requestedAt: d.requestedAt, verifiedAt: d.verifiedAt, lastCheckedAt: d.lastCheckedAt,
    pendingUntil: d.pendingUntil, txtName: d.txtName,
  };
}

export function fromEntitlement(e: WireEntitlement): Entitlement {
  return {
    plan: e.plan, source: e.source, maxUsers: e.maxUsers, maxManagementSystems: e.maxManagementSystems, frameworks: [...e.frameworks],
    storageAdapters: [...e.storageAdapters], features: [...e.features], rateUserPerMinute: e.rateUserPerMinute, rateOrgPerMinute: e.rateOrgPerMinute,
    graceDays: e.graceDays, validFrom: e.validFrom, validUntil: e.validUntil, version: e.version, updatedAt: e.updatedAt,
    usage: { users: e.usage.users, managementSystems: e.usage.managementSystems },
  };
}

export function fromPreset(p: WirePreset): PlanPreset {
  return {
    name: p.name, maxUsers: p.maxUsers, maxManagementSystems: p.maxManagementSystems, frameworks: [...p.frameworks], storageAdapters: [...p.storageAdapters],
    features: [...p.features], rateUserPerMinute: p.rateUserPerMinute, rateOrgPerMinute: p.rateOrgPerMinute, graceDays: p.graceDays, validDays: p.validDays,
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
    async organizations({ page, pageSize, q, status }) {
      const res = await call<Page<OpsOrganizationItem>>(client, ROUTES.orgList, { query: { page, pageSize, ...(q ? { q } : {}), ...(status ? { status } : {}) } });
      if (!res.ok) return fail(res);
      // The user limit of each row comes from the detail; a failed read leaves it unknown (the row shows the members).
      const items = await mapLimited(res.data.items, DETAIL_READS, async (o) => {
        const detail = await call<OpsOrganizationDetail>(client, ROUTES.orgGet, { params: { org: o.slug } });
        return fromOrg(o, detail.ok ? detail.data.entitlement?.maxUsers ?? null : null);
      });
      return { ok: true, data: { items, page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
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
    async organization(slug) {
      const res = await call<OpsOrganizationDetail>(client, ROUTES.orgGet, { params: { org: slug } });
      return res.ok ? { ok: true, data: fromDetail(res.data) } : fail(res);
    },
    async changeStatus(slug, body) {
      const res = await call<OrganizationStatusChangeResult>(client, ROUTES.orgStatus, { params: { org: slug }, body });
      if (!res.ok) return fail(res);
      const d = res.data.data;
      return {
        ok: true,
        data: { from: d.from, to: d.to, sessionsRevoked: d.sessionsRevoked, tenantAdmins: d.tenantAdmins, tenantAdminsEmailed: d.tenantAdminsEmailed, message: pair(res.data.message) },
      };
    },
    async events(slug, page, pageSize) {
      const res = await call<Page<OrganizationStatusEventItem>>(client, ROUTES.orgEvents, { params: { org: slug }, query: { page, pageSize } });
      if (!res.ok) return fail(res);
      return { ok: true, data: { items: res.data.items.map(fromEvent), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
    async domains(slug) {
      const res = await call<OrgDomain[]>(client, ROUTES.domainsList, { params: { org: slug } });
      return res.ok ? { ok: true, data: res.data.map(fromDomain) } : fail(res);
    },
    async addDomain(slug, domain) {
      const res = await call<OrgDomainAdded>(client, ROUTES.domainsAdd, { params: { org: slug }, body: { domain } });
      if (!res.ok) return fail(res);
      return { ok: true, data: { domain: res.data.domain, txtName: res.data.txtName, txtValue: res.data.txtValue, status: res.data.status } };
    },
    async verifyDomain(slug, domain) {
      const res = await call<OrgDomainCheck>(client, ROUTES.domainsVerify, { params: { org: slug, domain } });
      if (!res.ok) return fail(res);
      const check: DomainCheck = { ...fromDomain(res.data), recordFound: res.data.recordFound };
      return { ok: true, data: check };
    },
    async removeDomain(slug, domain) {
      const res = await call(client, ROUTES.domainsRemove, { params: { org: slug, domain } });
      return res.ok ? { ok: true, data: null } : fail(res);
    },
    async entitlement(slug) {
      const res = await call<WireEntitlement>(client, ROUTES.entitlementGet, { params: { org: slug } });
      if (res.ok) {
        const entitlement = fromEntitlement(res.data);
        return { ok: true, data: { entitlement, etag: entitlementEtag(entitlement) } };
      }
      // An organisation without an entitlement: the first one is written with If-Match `*` (M2-S10).
      if (res.error.status === 404 && res.error.messageKey === 'no_entitlement') return { ok: true, data: { entitlement: null, etag: '*' } };
      return fail(res);
    },
    async setEntitlement(slug, body, ifMatch) {
      const res = await call<EntitlementSetResult>(client, ROUTES.entitlementSet, { params: { org: slug }, body, ifMatch });
      if (!res.ok) return fail(res);
      const entitlement = fromEntitlement(res.data.data);
      const warnings = (res.data.warnings ?? []).map((w): [string, string] => [w.messages.en, w.messages.id]);
      return { ok: true, data: { entitlement, etag: entitlementEtag(entitlement), warnings } };
    },
    async plans() {
      const res = await call<WirePreset[]>(client, ROUTES.plans);
      return res.ok ? { ok: true, data: res.data.map(fromPreset) } : fail(res);
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
