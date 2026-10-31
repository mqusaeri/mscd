// The organisation export routes (Milestone 3 D.1, D.4, J.8 `organization_export.status`):
//
// - Tenant Admins (`org.export.manage`): list, request, read, decide, manifest and part download. A request waits for
//   another active Tenant Admin (`requested`) when the organisation has one; with a single Tenant Admin it is queued at
//   once and the answer says that nobody else approved it (H.2). The requester can never approve (`SOD-SELF-APPROVE`).
//   Every request, decision and download is audited and announced to every active Tenant Admin and every primary
//   Management System Manager. One export flows at a time (409 `export_in_progress`), and an organisation whose stored
//   files exceed `lifecycle.export_max_bytes` is refused (409 `export_too_large`).
// - Platform operators: the status of an organisation's exports (`ops.read`) and an export queued for its Tenant
//   Admins (`ops.tenants.manage`, audited `ops.export_requested`), never the content; multi tenancy only (409
//   `single_tenancy`).
//
// `platform.organization_export` is read and written in the organisation's tenant transaction (its row-level security
// shows the organisation its own rows); a status change needs the platform scope (trigger of platform 0007), which
// `inPlatformScope` switches on for that one statement.
import { Inject, Injectable } from '@nestjs/common';
import type {
  CommandResult,
  OpsOrganizationExportItem,
  OpsOrganizationExportQueued,
  OrganizationExportCreate,
  OrganizationExportCreated,
  OrganizationExportDecided,
  OrganizationExportDecision,
  OrganizationExportDetail,
  OrganizationExportItem,
} from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { fileResponseHeaders } from '../../common/file-response';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER,
  GATEWAY_CLIENT,
  JOB_QUEUE,
  NOTIFICATION_WRITER,
  SYSTEM_USER_ID,
  type AuditWriter,
  type GatewayClient,
  type JobQueue,
  type NotificationWriter,
  type Principal,
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { inPlatformScope } from '../identity/platform-scope';
import { ruleMessageKey, ruleMessages } from '../rules/messages';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf, tenantContextOf } from '../tenancy/tenant-scope';
import { exportTooLarge, partsOf, storedFileBytes } from './builder';
import { decidedNotice, downloadedNotice, notifyAll, operatorNotice, requestedNotice } from './notices';
import { activeTenantAdmins, exportPeople, nameOf, noticeRecipients } from './people';

/** Days a request waits for a decision before it expires (J.8 `requested` to `expired`). */
export const REQUEST_DECISION_DAYS = 7;
/** Retries of `org-export.build` after a failed attempt. */
export const BUILD_RETRIES = 1;

type ExportRow = {
  id: string;
  organization_id: string;
  status: OrganizationExportItem['status'];
  requested_via: OrganizationExportItem['requestedVia'];
  requested_by: string | null;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  is_final: boolean;
  part_count: number | null;
  file_count: number | null;
  size_bytes: string | null;
  parts: unknown;
  manifest_object_id: string | null;
  manifest_sha256: string | null;
  expires_at: Date | null;
  completed_at: Date | null;
  download_count: number;
  error: string | null;
};

const COLUMNS = [
  'id', 'organization_id', 'status', 'requested_via', 'requested_by', 'requested_at', 'decided_by', 'decided_at', 'decision_note', 'is_final', 'part_count',
  'file_count', 'size_bytes', 'parts', 'manifest_object_id', 'manifest_sha256', 'expires_at', 'completed_at', 'download_count', 'error',
] as const;

/** 409 `conflict` with messageKey `export_in_progress` (J.6). */
export function exportInProgress(): ConflictError {
  return new ConflictError('Another export of this organisation is waiting for approval or being built', {
    messageKey: 'export_in_progress',
    messages: {
      en: 'Another export of this organisation is waiting for approval or being built. Wait until it is ready, rejected or failed.',
      id: 'Ekspor lain dari organisasi ini sedang menunggu persetujuan atau sedang dibuat. Tunggu sampai ekspor itu siap, ditolak atau gagal.',
    },
  });
}

/** 409 `conflict` with messageKey `single_tenancy` (J.6): the operator routes belong to multi tenancy. */
export function singleTenancyRefusal(): ConflictError {
  return new ConflictError('This installation runs one organisation (tenancy.mode single); its Tenant Admins export it themselves', {
    messageKey: 'single_tenancy',
  });
}

/** The date code of an export in audit entries and notices (`export-2026-10-31`). */
export function exportCode(requestedAt: Date): string {
  return `export-${requestedAt.toISOString().slice(0, 10)}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function bytesOf(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

@Injectable()
export class OrgExportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly config: MscdConfig,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  // ------------------------------------------------------------------------------------------------ Tenant Admins

  /** `GET /admin/organization/exports`: newest first. */
  async list(principal: Principal): Promise<OrganizationExportItem[]> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const rows = (await trx
        .selectFrom('platform.organization_export')
        .select(COLUMNS)
        .where('organization_id', '=', principal.org!.id)
        .orderBy('requested_at', 'desc')
        .orderBy('id')
        .execute()) as ExportRow[];
      const people = await exportPeople(trx, principal.org!.id, rows.flatMap((r) => [r.requested_by, r.decided_by]));
      return rows.map((row) => this.item(row, people));
    });
  }

  /** `GET /admin/organization/exports/{id}`. */
  async get(principal: Principal, id: string): Promise<OrganizationExportDetail> {
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.row(trx, principal.org!.id, id);
      const people = await exportPeople(trx, principal.org!.id, [row.requested_by, row.decided_by]);
      return {
        ...this.item(row, people),
        parts: partsOf(row.parts).map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
        manifestSha256: row.manifest_sha256,
      };
    });
  }

  /** `POST /admin/organization/exports` (202). */
  async create(principal: Principal, body: OrganizationExportCreate): Promise<OrganizationExportCreated> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      await this.lockExports(trx, org.id);
      await this.assertNoneRunning(trx, org.id);
      await this.assertSize(trx, org.id);
      const admins = await activeTenantAdmins(trx, org.id);
      const approvalNeeded = admins.some((id) => id !== principal.user.id);
      const status = approvalNeeded ? 'requested' : 'queued';
      const now = this.clock.now();
      const row = await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: org.id, status, requested_via: 'tenant_admin', requested_by: principal.user.id, requested_at: now })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const code = exportCode(now);
      await this.audit.record(trx, {
        action: 'organization_export.requested',
        entityType: 'organization_export',
        entityId: row.id,
        entityCode: code,
        after: { status, requestedVia: 'tenant_admin', approvalNeeded, ...(body.note ? { note: body.note } : {}) },
      });
      const notice = requestedNotice(principal.user.displayName, org.name, approvalNeeded, body.note);
      await notifyAll(this.notifications, trx, await noticeRecipients(trx, org.id), {
        kind: 'organization_export_requested', ...notice, id: row.id, code, createdBy: principal.user.id,
      });
      if (!approvalNeeded) await this.queueBuild(trx, org.id, row.id, principal.user.id);
      return {
        ok: true,
        changed: [],
        data: { id: row.id, status, approvalNeeded },
        message: approvalNeeded
          ? ['The export waits for another Tenant Admin to approve it.', 'Ekspor menunggu persetujuan Tenant Admin lain.']
          : [
              'The export was queued. Nobody else approved it, because the organisation has one Tenant Admin.',
              'Ekspor diantrekan. Tidak ada orang lain yang menyetujuinya, karena organisasi hanya memiliki satu Tenant Admin.',
            ],
      };
    });
  }

  /** `POST /admin/organization/exports/{id}/decision`: another Tenant Admin approves or rejects. */
  async decide(principal: Principal, id: string, body: OrganizationExportDecision): Promise<OrganizationExportDecided> {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      await this.lockExports(trx, org.id);
      const row = await this.row(trx, org.id, id, { forUpdate: true });
      if (row.status !== 'requested') {
        throw new ConflictError(`The export is ${row.status}; only a requested export can be decided`, {
          messageKey: 'export_not_requested',
          messages: {
            en: `This export is ${row.status}. Only an export that waits for approval can be approved or rejected.`,
            id: `Ekspor ini berstatus ${row.status}. Hanya ekspor yang menunggu persetujuan yang dapat disetujui atau ditolak.`,
          },
        });
      }
      if (row.requested_by === principal.user.id) {
        throw new BusinessRuleError('SOD-SELF-APPROVE', ruleMessages('SOD-SELF-APPROVE'), undefined, { messageKey: ruleMessageKey('SOD-SELF-APPROVE') });
      }
      const now = this.clock.now();
      if (row.requested_at.getTime() + REQUEST_DECISION_DAYS * 86_400_000 <= now.getTime()) {
        throw new ConflictError('The request waited more than 7 days for a decision and has expired', {
          messageKey: 'export_request_expired',
          messages: {
            en: 'This request waited more than 7 days for a decision and has expired. Ask for a new export.',
            id: 'Permintaan ini menunggu keputusan lebih dari 7 hari dan telah kedaluwarsa. Minta ekspor baru.',
          },
        });
      }
      const status = body.approve ? 'queued' : 'rejected';
      if (body.approve) await this.assertNoneRunning(trx, org.id, row.id);
      await inPlatformScope(trx, () =>
        trx
          .updateTable('platform.organization_export')
          .set({ status, decided_by: principal.user.id, decided_at: now, decision_note: body.note ?? null })
          .where('id', '=', row.id)
          .execute(),
      );
      const code = exportCode(row.requested_at);
      await this.audit.record(trx, {
        action: 'organization_export.decided',
        entityType: 'organization_export',
        entityId: row.id,
        entityCode: code,
        before: { status: 'requested' },
        after: { status, approve: body.approve, ...(body.note ? { note: body.note } : {}) },
      });
      const people = await exportPeople(trx, org.id, [row.requested_by]);
      const requester = nameOf(people, row.requested_by)?.displayName ?? 'a Tenant Admin';
      await notifyAll(this.notifications, trx, await noticeRecipients(trx, org.id), {
        kind: 'organization_export_requested',
        ...decidedNotice(principal.user.displayName, requester, body.approve, body.note),
        id: row.id,
        code,
        createdBy: principal.user.id,
      });
      if (body.approve) await this.queueBuild(trx, org.id, row.id, principal.user.id);
      return { ok: true, changed: [], data: { id: row.id, status } };
    });
  }

  /** `GET /admin/organization/exports/{id}/manifest`: the full manifest as a JSON attachment. */
  async manifest(reply: FastifyReply, principal: Principal, id: string): Promise<FastifyReply> {
    const prepared = await this.prepareDownload(principal, id, 'manifest');
    return this.send(reply, prepared, 'application/json');
  }

  /** `GET /admin/organization/exports/{id}/parts/{part}`: one part with its SHA-256 in `X-MSCD-SHA256`. */
  async download(reply: FastifyReply, principal: Principal, id: string, part: number): Promise<FastifyReply> {
    const prepared = await this.prepareDownload(principal, id, part);
    return this.send(reply, prepared, 'application/gzip');
  }

  // ---------------------------------------------------------------------------------------------------- operators

  /** `GET /ops/organizations/{org}/exports`: status, dates and sizes, newest first. */
  async opsList(slug: string): Promise<OpsOrganizationExportItem[]> {
    const org = await this.operatorOrganisation(slug);
    return this.scope.withTenant(systemContextOf(org), async (trx) => {
      const rows = (await trx
        .selectFrom('platform.organization_export')
        .select(COLUMNS)
        .where('organization_id', '=', org.id)
        .orderBy('requested_at', 'desc')
        .orderBy('id')
        .execute()) as ExportRow[];
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        requestedVia: row.requested_via,
        requestedAt: row.requested_at.toISOString(),
        completedAt: iso(row.completed_at),
        expiresAt: iso(row.expires_at),
        isFinal: row.is_final,
        partCount: row.part_count,
        sizeBytes: bytesOf(row.size_bytes),
        downloadCount: row.download_count,
      }));
    });
  }

  /** `POST /ops/organizations/{org}/exports` (202): an export queued for the Tenant Admins. */
  async opsCreate(principal: Principal, slug: string, reason: string): Promise<OpsOrganizationExportQueued> {
    const org = await this.operatorOrganisation(slug);
    if (org.status !== 'active' && org.status !== 'offboarding') {
      throw new ConflictError(`Organisation ${org.slug} is ${org.status}; exports run for active and offboarding organisations`, {
        messageKey: 'export_not_available',
        messages: {
          en: `Organisation ${org.slug} is ${org.status}. An export can be made while it is active or offboarding.`,
          id: `Organisasi ${org.slug} berstatus ${org.status}. Ekspor dapat dibuat selama organisasi aktif atau dalam masa offboarding.`,
        },
      });
    }
    return this.scope.withTenant(systemContextOf(org), async (trx) => {
      await this.lockExports(trx, org.id);
      await this.assertNoneRunning(trx, org.id);
      await this.assertSize(trx, org.id);
      const now = this.clock.now();
      const row = await trx
        .insertInto('platform.organization_export')
        .values({ organization_id: org.id, status: 'queued', requested_via: 'operator', requested_by: principal.user.id, requested_at: now })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const code = exportCode(now);
      await this.audit.record(trx, {
        action: 'ops.export_requested',
        actor: { userId: principal.user.id, kind: 'operator' },
        organizationId: org.id,
        entityType: 'organization_export',
        entityId: row.id,
        entityCode: org.slug,
        after: { status: 'queued', requestedVia: 'operator', reason },
      });
      await notifyAll(this.notifications, trx, await noticeRecipients(trx, org.id), {
        kind: 'organization_export_requested', ...operatorNotice(org.name), id: row.id, code, createdBy: SYSTEM_USER_ID,
      });
      await this.queueBuild(trx, org.id, row.id, null);
      return {
        ok: true,
        changed: [],
        data: { id: row.id, status: 'queued' },
        message: [
          `The export of ${org.slug} was queued; its Tenant Admins are told and download it when it is ready`,
          `Ekspor ${org.slug} diantrekan; Tenant Admin-nya diberi tahu dan mengunduhnya setelah siap`,
        ],
      } satisfies CommandResult & OpsOrganizationExportQueued;
    });
  }

  // -------------------------------------------------------------------------------------------------- internals

  private item(row: ExportRow, people: Awaited<ReturnType<typeof exportPeople>>): OrganizationExportItem {
    return {
      id: row.id,
      status: row.status,
      requestedVia: row.requested_via,
      requestedBy: row.requested_via === 'tenant_admin' ? nameOf(people, row.requested_by) : null,
      requestedAt: row.requested_at.toISOString(),
      decidedBy: nameOf(people, row.decided_by),
      decidedAt: iso(row.decided_at),
      decisionNote: row.decision_note,
      isFinal: row.is_final,
      partCount: row.part_count,
      fileCount: row.file_count,
      sizeBytes: bytesOf(row.size_bytes),
      expiresAt: iso(row.expires_at),
      completedAt: iso(row.completed_at),
      downloadCount: row.download_count,
      error: row.error,
    };
  }

  private async row(trx: Trx, orgId: string, id: string, options: { forUpdate?: boolean } = {}): Promise<ExportRow> {
    let query = trx.selectFrom('platform.organization_export').select(COLUMNS).where('id', '=', id).where('organization_id', '=', orgId);
    if (options.forUpdate) query = query.forUpdate();
    const row = (await query.executeTakeFirst()) as ExportRow | undefined;
    if (!row) throw new NotFoundError('No such export');
    return row;
  }

  /** Serialises the export commands of one organisation (two requests at once never both pass the checks). */
  private async lockExports(trx: Trx, orgId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`org-export:${orgId}`}, 0))`.execute(trx);
  }

  /** 409 `export_in_progress` while another export waits for approval, is queued or is being built. */
  private async assertNoneRunning(trx: Trx, orgId: string, except?: string): Promise<void> {
    let query = trx.selectFrom('platform.organization_export').select('id').where('organization_id', '=', orgId);
    if (except) query = query.where('id', '<>', except);
    const running = await query
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['queued', 'building']),
          eb.and([eb('status', '=', 'requested'), eb('requested_at', '>', new Date(this.clock.now().getTime() - REQUEST_DECISION_DAYS * 86_400_000))]),
        ]),
      )
      .executeTakeFirst();
    if (running) throw exportInProgress();
  }

  /** 409 `export_too_large` when the stored files exceed `lifecycle.export_max_bytes`. */
  private async assertSize(trx: Trx, orgId: string): Promise<void> {
    const limit = this.config.profile.lifecycle.export_max_bytes;
    const bytes = await storedFileBytes(trx, orgId);
    if (bytes > limit) throw exportTooLarge(bytes, limit);
  }

  private async queueBuild(trx: Trx, orgId: string, exportId: string, requestedBy: string | null): Promise<void> {
    await this.jobs.send(
      'org-export.build',
      { orgId, ...(requestedBy ? { requestedBy } : {}), payload: { exportId } },
      { singletonKey: `oe:${exportId}`, retryLimit: BUILD_RETRIES },
      trx,
    );
  }

  /** The organisation of an operator route: multi tenancy only (409 `single_tenancy`), 404 for an unknown slug. */
  private async operatorOrganisation(slug: string): Promise<TenantInfo> {
    if (this.config.profile.tenancy.mode !== 'multi') throw singleTenancyRefusal();
    const org = await this.tenants.resolveBySlug(slug);
    if (!org) throw new NotFoundError(`Unknown organisation ${slug}`);
    return org;
  }

  /**
   * The object of a manifest or part download, with the audit entry, the download count and the notice to every
   * Tenant Admin and primary Management System Manager written in one transaction before the bytes are sent.
   */
  private async prepareDownload(principal: Principal, id: string, what: number | 'manifest') {
    const org = principal.org!;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await this.row(trx, org.id, id, { forUpdate: true });
      const now = this.clock.now();
      if (row.status !== 'ready' || (row.expires_at && row.expires_at.getTime() <= now.getTime())) {
        throw new ConflictError(`The export is ${row.status === 'ready' ? 'expired' : row.status}; only a ready export can be downloaded`, {
          messageKey: 'export_not_ready',
          messages: {
            en: row.status === 'ready' || row.status === 'expired' ? 'This export has expired. Ask for a new export.' : 'This export is not ready yet.',
            id: row.status === 'ready' || row.status === 'expired' ? 'Ekspor ini telah kedaluwarsa. Minta ekspor baru.' : 'Ekspor ini belum siap.',
          },
        });
      }
      const parts = partsOf(row.parts);
      let objectId: string | null;
      let fileName: string;
      let sha256: string | null;
      if (what === 'manifest') {
        objectId = row.manifest_object_id;
        fileName = parts[0] ? parts[0].name.replace(/-part-\d+\.tar\.gz$/, '-manifest.json') : 'manifest.json';
        sha256 = row.manifest_sha256;
      } else {
        const part = parts.find((p) => p.part === what);
        if (!part) throw new NotFoundError(`The export has no part ${what}`);
        objectId = part.storageObjectId;
        fileName = part.name;
        sha256 = part.sha256;
      }
      if (!objectId) throw new NotFoundError('The file of the export is gone');
      const object = await trx.selectFrom('storage_object').selectAll().where('id', '=', objectId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!object) throw new NotFoundError('The file of the export is gone');
      const repositoryRow = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
      const repository = await this.storage.repository(trx, repositoryRow, { withCredential: false });
      const tenant = await this.storage.tenant(trx, org.id);
      await trx
        .updateTable('platform.organization_export')
        .set({ download_count: sql<number>`download_count + 1` })
        .where('id', '=', row.id)
        .execute();
      const code = exportCode(row.requested_at);
      await this.audit.record(trx, {
        action: 'organization_export.downloaded',
        entityType: 'organization_export',
        entityId: row.id,
        entityCode: code,
        after: what === 'manifest' ? { file: 'manifest', fileName, sha256 } : { part: what, parts: parts.length, fileName, sha256 },
      });
      await notifyAll(this.notifications, trx, await noticeRecipients(trx, org.id), {
        kind: 'organization_export_requested',
        ...downloadedNotice(principal.user.displayName, what === 'manifest' ? 'manifest' : { part: what, parts: parts.length }),
        id: row.id,
        code,
        createdBy: principal.user.id,
      });
      return {
        request: {
          tenant,
          repository,
          object: {
            externalItemId: object.external_item_id,
            externalVersionId: object.external_version_id,
            hashAlgorithm: object.hash_algorithm,
            hashValue: object.hash_value,
            hashSource: object.hash_source,
            folderPath: object.folder_path,
          },
        },
        fileName,
        sha256,
        size: object.size_bytes === null ? null : Number(object.size_bytes),
      };
    });
  }

  private async send(
    reply: FastifyReply,
    prepared: { request: unknown; fileName: string; sha256: string | null; size: number | null },
    contentType: 'application/json' | 'application/gzip',
  ): Promise<FastifyReply> {
    const streamed = await this.gateway.stream(prepared.request);
    const headers = fileResponseHeaders({ storedType: contentType, fileName: prepared.fileName, size: streamed.size ?? prepared.size });
    headers['content-type'] = contentType;
    if (prepared.sha256) headers['x-mscd-sha256'] = prepared.sha256;
    reply.headers(headers);
    return reply.status(200).send(streamed.stream);
  }
}
