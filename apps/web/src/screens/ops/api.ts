// API adapter of the operator console through the host's client (R-17). The diagnostics archive is binary, which the
// client reads as text, so that one request goes through `fetch` with the client's CSRF token and language (M2-16
// handoff deviation 6, until the client offers a binary answer). A 401 of that request reads the health through the
// client, so the client's session-ended path (the sign-in page) runs as for any other request.
//
// The organisation lifecycle (M2-S12): detail, status and history (M2-S09), domains (M2-S11), entitlements and plans
// (M2-S10). The accounts and the platform operators (M2-19): each action sends the reason, an idempotency key and, for
// the status change, the account's ETag as `If-Match`. The list item carries no user limit, so the list reads the detail of each organisation of the page (at
// most `DETAIL_READS` at a time) for it (M2-S12 handoff deviation 1). The client answers the body only, so the
// `If-Match` value of an entitlement change is built from the body (`entitlementEtag`, deviation 2).
//
// The end of a contract (M3-09): the read-only end, the deletion and the last export of each organisation (D.2), the
// exports of an organisation and "Start export" (`ops.exports.*`, never a download), and the verified deletion
// (`ops.deletion.*`); an organisation without a deletion answers 404, which the adapter gives as null. The certificate
// is saved through the api's own link, so the session cookie goes with it.
import type {
  CommandResult, Entitlement as WireEntitlement, OpsAccountActionResult, OpsAccountDetail, OpsAccountItem, OpsOperatorAddResult, OpsOperatorItem,
  OpsOperatorRemoveResult, EntitlementSetResult, JobRunResponse, OpsHealth, OpsOrganizationCreateResult, OpsOrganizationDetail,
  OpsOrganizationExportItem, OpsOrganizationExportQueued, OpsOrganizationItem, OrgDomain, OrgDomainAdded, OrgDomainCheck, OrganizationDeletionResult,
  OrganizationDeletionView, OrganizationStatusChangeResult, OrganizationStatusEventItem, PackSummary, PlanPreset as WirePreset, QueueStats,
} from '@mscd/shared';
import { toApiError } from '../../data/api/ApiClient';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { NO_CLIENT, call } from '../api';
import type { Page } from '../api';
import type { AccountDetail, AccountItem, ActionDone, OperatorItem } from './account-model';
import type { DeletionDone, DeletionView, OpsExport } from './lifecycle-model';
import type { Health, OpsAdapter, OrgItem, PackItem, Result } from './model';
import { entitlementEtag, mapLimited } from './org-model';
import type { Domain, DomainCheck, Entitlement, OrgDetail, PlanPreset, StatusEvent } from './org-model';
import { ROUTES, pathOf } from './routes';

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

/** The read-only end, the deletion and the last export of an organisation (Milestone 3 D.2); null means none. */
function lifecycleOf(o: Pick<OpsOrganizationItem, 'offboardingEndsAt' | 'deletion' | 'lastExport'>): Pick<OrgDetail, 'offboardingEndsAt' | 'deletion' | 'lastExport'> {
  return {
    offboardingEndsAt: o.offboardingEndsAt ?? null,
    deletion: o.deletion ? { status: o.deletion.status, scheduledFor: o.deletion.scheduledFor } : null,
    lastExport: o.lastExport ? { status: o.lastExport.status, readyAt: o.lastExport.readyAt } : null,
  };
}

export function fromOrg(o: OpsOrganizationItem, maxUsers: number | null = null): OrgItem {
  return {
    slug: o.slug, name: o.name, status: o.status, licence: o.licence ? { state: o.licence.state, validUntil: o.licence.validUntil } : null,
    memberCount: o.memberCount, systemCount: o.systemCount, plan: o.plan, validUntil: o.validUntil, verifiedDomains: [...o.verifiedDomains],
    maxUsers, createdAt: o.createdAt, ...lifecycleOf(o),
  };
}

export function fromDetail(d: OpsOrganizationDetail): OrgDetail {
  return {
    slug: d.slug, name: d.name, status: d.status, region: d.region, createdAt: d.createdAt, memberCount: d.memberCount, systemCount: d.systemCount,
    entitlement: d.entitlement ? { ...d.entitlement } : null,
    domains: d.domains.map((x) => ({ domain: x.domain, status: x.status })),
    lastSignInAt: d.lastSignInAt,
    ...lifecycleOf(d),
  };
}

export function fromOpsExport(e: OpsOrganizationExportItem): OpsExport {
  return {
    id: e.id, status: e.status, requestedVia: e.requestedVia, requestedAt: e.requestedAt, completedAt: e.completedAt, expiresAt: e.expiresAt,
    isFinal: e.isFinal, partCount: e.partCount, sizeBytes: e.sizeBytes, downloadCount: e.downloadCount,
  };
}

export function fromDeletion(d: OrganizationDeletionView): DeletionView {
  return {
    id: d.id, status: d.status, scheduledFor: d.scheduledFor, scheduledBy: d.scheduledBy ? { handle: d.scheduledBy.handle, displayName: d.scheduledBy.displayName } : null,
    reason: d.reason, archivedAt: d.archivedAt, earliestAllowed: d.earliestAllowed, finalExportId: d.finalExportId, startedAt: d.startedAt,
    completedAt: d.completedAt, failedStep: d.failedStep, error: d.error, steps: d.steps.map((s) => ({ step: s.step, status: s.status, at: s.at, detail: s.detail })),
    vaultObjectsDeleted: d.vaultObjectsDeleted, certificateId: d.certificateId,
  };
}

function fromDeletionResult(r: OrganizationDeletionResult): DeletionDone {
  return { id: r.data.id, status: r.data.status, scheduledFor: r.data.scheduledFor, message: pair(r.message) };
}

/** The api's link of the deletion certificate of an organisation. */
export const certificateHref = (slug: string): string => pathOf(ROUTES.deletionCertificate, { org: slug });

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

export function fromAccount(a: OpsAccountItem): AccountItem {
  return {
    id: a.id, handle: a.handle, email: a.email, displayName: a.displayName, kind: a.kind, status: a.status, mfaEnrolled: a.mfaEnrolled, locked: a.locked,
    lastSignInAt: a.lastSignInAt, createdAt: a.createdAt, platformOperator: a.platformOperator,
    memberships: a.memberships.map((m) => ({ org: m.org, orgName: m.orgName, status: m.status, adminRoles: [...m.adminRoles] })), etag: a.etag,
  };
}

export function fromAccountDetail(a: OpsAccountDetail): AccountDetail {
  return {
    ...fromAccount(a),
    sessions: a.sessions.map((s) => ({ startedAt: s.startedAt, lastSeenAt: s.lastSeenAt, method: s.method, state: s.state, network: s.network, browser: s.browser, org: s.org })),
    audit: a.audit.map((e) => ({ at: e.at, action: e.action, actorKind: e.actorKind, actor: e.actor ? { ...e.actor } : null, org: e.org, reason: e.reason })),
  };
}

export function fromAction(r: OpsAccountActionResult): ActionDone {
  return { status: r.data.status, sessionsRevoked: r.data.sessionsRevoked, emailed: r.data.emailed, link: r.data.link ?? null, message: pair(r.message) };
}

export function fromOperator(o: OpsOperatorItem): OperatorItem {
  return {
    id: o.id, handle: o.handle, email: o.email, displayName: o.displayName, status: o.status, mfaEnrolled: o.mfaEnrolled, passwordSet: o.passwordSet,
    lastSignInAt: o.lastSignInAt, grantedAt: o.grantedAt, grantedBy: o.grantedBy ? { ...o.grantedBy } : null, self: o.self,
  };
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
    async organizationNames() {
      // One page of 200 without the detail reads of `organizations`: the filter needs the slug and the name only.
      const res = await call<Page<OpsOrganizationItem>>(client, ROUTES.orgList, { query: { page: 1, pageSize: 200 } });
      return res.ok ? { ok: true, data: res.data.items.map((o) => ({ slug: o.slug, name: o.name })) } : fail(res);
    },
    async accounts({ page, pageSize, q, org, status, kind }) {
      const query = { page, pageSize, ...(q ? { q } : {}), ...(org ? { org } : {}), ...(status ? { status } : {}), ...(kind ? { kind } : {}) };
      const res = await call<Page<OpsAccountItem>>(client, ROUTES.accounts, { query });
      if (!res.ok) return fail(res);
      return { ok: true, data: { items: res.data.items.map(fromAccount), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
    async account(id) {
      const res = await call<OpsAccountDetail>(client, ROUTES.account, { params: { id } });
      return res.ok ? { ok: true, data: fromAccountDetail(res.data) } : fail(res);
    },
    async resetMfa(id, reason, idempotencyKey) {
      const res = await call<OpsAccountActionResult>(client, ROUTES.accountResetMfa, { params: { id }, body: { reason }, idempotencyKey });
      return res.ok ? { ok: true, data: fromAction(res.data) } : fail(res);
    },
    async sendPasswordLink(id, reason, idempotencyKey) {
      const res = await call<OpsAccountActionResult>(client, ROUTES.accountPassword, { params: { id }, body: { reason }, idempotencyKey });
      return res.ok ? { ok: true, data: fromAction(res.data) } : fail(res);
    },
    async resendInvitation(id, org, reason, idempotencyKey) {
      const res = await call<OpsAccountActionResult>(client, ROUTES.accountResend, { params: { id, org }, body: { reason }, idempotencyKey });
      return res.ok ? { ok: true, data: fromAction(res.data) } : fail(res);
    },
    async endSessions(id, reason, idempotencyKey) {
      const res = await call<OpsAccountActionResult>(client, ROUTES.accountSessions, { params: { id }, body: { reason }, idempotencyKey });
      return res.ok ? { ok: true, data: fromAction(res.data) } : fail(res);
    },
    async setAccountStatus(id, status, reason, ifMatch) {
      const res = await call<OpsAccountActionResult>(client, ROUTES.accountStatus, { params: { id }, body: { status, reason }, ifMatch });
      return res.ok ? { ok: true, data: fromAction(res.data) } : fail(res);
    },
    async operators() {
      const res = await call<OpsOperatorItem[]>(client, ROUTES.operators);
      return res.ok ? { ok: true, data: res.data.map(fromOperator) } : fail(res);
    },
    async addOperator(body, idempotencyKey) {
      const res = await call<OpsOperatorAddResult>(client, ROUTES.operatorAdd, { body, idempotencyKey });
      if (!res.ok) return fail(res);
      const d = res.data.data;
      return { ok: true, data: { id: d.id, email: d.email, newAccount: d.newAccount, emailed: d.emailed, link: d.link ?? null, message: pair(res.data.message) } };
    },
    async removeOperator(id, reason) {
      const res = await call<OpsOperatorRemoveResult>(client, ROUTES.operatorRemove, { params: { id }, body: { reason } });
      if (!res.ok) return fail(res);
      return { ok: true, data: { sessionsRevoked: res.data.data.sessionsRevoked, operatorsLeft: res.data.data.operatorsLeft, message: pair(res.data.message) } };
    },
    async exports(slug) {
      const res = await call<OpsOrganizationExportItem[]>(client, ROUTES.exportsList, { params: { org: slug } });
      return res.ok ? { ok: true, data: res.data.map(fromOpsExport) } : fail(res);
    },
    async startExport(slug, reason, idempotencyKey) {
      const res = await call<OpsOrganizationExportQueued>(client, ROUTES.exportsCreate, { params: { org: slug }, body: { reason }, idempotencyKey });
      return res.ok ? { ok: true, data: { id: res.data.data.id, message: pair(res.data.message) } } : fail(res);
    },
    async deletion(slug) {
      const res = await call<OrganizationDeletionView>(client, ROUTES.deletionGet, { params: { org: slug } });
      if (res.ok) return { ok: true, data: fromDeletion(res.data) };
      // An organisation that never had a deletion answers 404 (an unknown slug would fail the detail read first).
      if (res.error.status === 404) return { ok: true, data: null };
      return fail(res);
    },
    async scheduleDeletion(slug, body) {
      const res = await call<OrganizationDeletionResult>(client, ROUTES.deletionSchedule, { params: { org: slug }, body });
      return res.ok ? { ok: true, data: fromDeletionResult(res.data) } : fail(res);
    },
    async cancelDeletion(slug, reason) {
      const res = await call<OrganizationDeletionResult>(client, ROUTES.deletionCancel, { params: { org: slug }, body: { reason } });
      return res.ok ? { ok: true, data: fromDeletionResult(res.data) } : fail(res);
    },
    async retryDeletion(slug, reason) {
      const res = await call<OrganizationDeletionResult>(client, ROUTES.deletionRetry, { params: { org: slug }, body: { reason } });
      return res.ok ? { ok: true, data: fromDeletionResult(res.data) } : fail(res);
    },
    async certificate(slug) {
      // No name of its own: the browser takes the server's (`deletion-certificate-<slug>-<date>.json`, Content-Disposition).
      return { ok: true, data: { href: certificateHref(slug), fileName: '' } };
    },
  };
}
