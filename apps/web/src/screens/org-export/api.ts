// API adapter of Organisation export through the host's client (R-17, MILESTONE-3 M3-09): the organisation settings for
// the admin count and the read-only period (`admin.organization.get`), the exports, one export with its parts, the
// request with an idempotency key, the decision of another Tenant Admin, and the downloads. A part or the manifest is
// downloaded through the api's own link (the session cookie goes with it; the api streams the file with its SHA-256 in
// `X-MSCD-SHA256`, audits the download and tells the Tenant Admins), so a part of 2 GB never passes through script.
import type {
  OrganizationExportCreated, OrganizationExportDecided, OrganizationExportDetail, OrganizationExportItem, OrganizationSettings,
} from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import { call } from '../api';
import type { Download } from '../auditor-access/shared';
import type { Lifecycle, OrgExport, OrgExportAdapter, OrgExportDetail, Result } from './model';
import { ROUTES, pathOf } from './routes';

const fail = <T,>(res: ApiResult<unknown> & { ok: false }): Result<T> => ({ ok: false, error: res.error });
const pair = (m: unknown): [string, string] | null => (Array.isArray(m) && m.length === 2 ? [String(m[0]), String(m[1])] : null);
const person = (p: { handle: string; displayName: string } | null) => (p ? { handle: p.handle, displayName: p.displayName } : null);

export function fromExport(e: OrganizationExportItem): OrgExport {
  return {
    id: e.id, status: e.status, requestedVia: e.requestedVia, requestedBy: person(e.requestedBy), requestedAt: e.requestedAt,
    decidedBy: person(e.decidedBy), decidedAt: e.decidedAt, decisionNote: e.decisionNote, isFinal: e.isFinal, partCount: e.partCount,
    fileCount: e.fileCount, sizeBytes: e.sizeBytes, expiresAt: e.expiresAt, completedAt: e.completedAt, downloadCount: e.downloadCount, error: e.error,
  };
}

export function fromDetail(d: OrganizationExportDetail): OrgExportDetail {
  return {
    ...fromExport(d),
    parts: d.parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
    manifestSha256: d.manifestSha256,
  };
}

export function fromSettings(s: OrganizationSettings): Lifecycle {
  return { activeAdminCount: s.activeAdminCount, offboardingEndsAt: s.offboardingEndsAt, deletionScheduledFor: s.deletionScheduledFor };
}

/** The api's link of one part of an export. */
export const partHref = (id: string, part: number): string => pathOf(ROUTES.download, { id, part: String(part) });
/** The api's link of the manifest of an export. */
export const manifestHref = (id: string): string => pathOf(ROUTES.manifest, { id });

export function createApiAdapter(client: ApiClient | null): OrgExportAdapter {
  return {
    async lifecycle() {
      const res = await call<OrganizationSettings>(client, ROUTES.organization);
      return res.ok ? { ok: true, data: fromSettings(res.data) } : fail(res);
    },
    async list() {
      const res = await call<OrganizationExportItem[]>(client, ROUTES.list);
      return res.ok ? { ok: true, data: res.data.map(fromExport) } : fail(res);
    },
    async get(id) {
      const res = await call<OrganizationExportDetail>(client, ROUTES.get, { params: { id } });
      return res.ok ? { ok: true, data: fromDetail(res.data) } : fail(res);
    },
    async create(note, idempotencyKey) {
      const res = await call<OrganizationExportCreated>(client, ROUTES.create, { body: note ? { note } : {}, idempotencyKey });
      if (!res.ok) return fail(res);
      const d = res.data.data;
      return { ok: true, data: { id: d.id, status: d.status, approvalNeeded: d.approvalNeeded, message: pair(res.data.message) } };
    },
    async decide(id, approve, note) {
      const res = await call<OrganizationExportDecided>(client, ROUTES.decide, { params: { id }, body: { approve, ...(note ? { note } : {}) } });
      if (!res.ok) return fail(res);
      return { ok: true, data: { id: res.data.data.id, status: res.data.data.status, message: pair(res.data.message) } };
    },
    async partFile(detail, part) {
      const file: Download = { href: partHref(detail.id, part.part), fileName: part.name };
      return { ok: true, data: file };
    },
    async manifestFile(detail) {
      // No name of its own: the browser takes the server's (`<base>-manifest.json`, Content-Disposition).
      return { ok: true, data: { href: manifestHref(detail.id), fileName: '' } };
    },
  };
}
