// Export routes (build plan D.3 "Page actions", E.2 `export.build`, F.13, F.15):
//
// - `POST /exports` (202): the guard has checked the D.3 permission (portfolio board: `export.run` in any system;
//   audit trail: `audit_trail.read` in `ms`; others: `export.run` in `ms`). Writes a `background_task` (kind
//   `export`), queues `export.build` in the same transaction and answers with its `taskId`.
// - `GET /exports/{taskId}`: the task for its creator only (404 for anyone else).
// - `GET /exports/{taskId}/download`: the creator only, the permission checked again, the file streamed from the
//   Managed Vault through `FileResponder` (attachment), audited `export.downloaded`.
// - `GET /ms/{ms}/applicability/export` and `GET /ms/{ms}/documents/export`: the SoA and the document register built
//   synchronously for the session user and streamed at once (audited `export.downloaded`).
//
// Milestone 3 (D.2, D.6.3, M3-04): personal data exports (`export_file` kind `personal_data`, format `json`) are queued
// by `exports.person.create` (an access request, by a Tenant Admin) and `exports.me.create` (the person) through
// `queuePersonalData`, never through `POST /exports`. `GET /exports/{taskId}` and the download serve them to their
// creator only: a person's own export to that person, an access request export to the Tenant Admin who queued it, with
// `privacy_request.manage` checked again at the download.
import { Inject, Injectable } from '@nestjs/common';
import type { BackgroundTask, CommandResult, ExportRequest } from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import { Clock } from '../../common/clock';
import { FileResponder } from '../../common/file-response';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/problems';
import {
  AUDIT_WRITER, GATEWAY_CLIENT, JOB_QUEUE, PERMISSION_EVALUATOR, type AuditWriter, type GatewayClient, type JobQueue, type PermissionEvaluator, type Principal,
  type Trx,
} from '../../common/tokens';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { assertFormat, CONTENT_TYPES, ExportContentService, type ExportSpec, type Lang } from './export-content.service';

/** Download path of a finished export. */
export function exportDownloadUrl(taskId: string): string {
  return `/api/v1/exports/${taskId}/download`;
}

const TYPE_NAMES: Readonly<Record<ExportRequest['type'] | 'personal_data', readonly [string, string]>> = {
  portfolio_board: ['Portfolio board', 'Papan portofolio'],
  readiness: ['Readiness report', 'Laporan kesiapan'],
  soa: ['Statement of Applicability', 'Pernyataan Keberlakuan'],
  document_register: ['Document register', 'Daftar dokumen'],
  audit_trail: ['Audit trail', 'Jejak audit'],
  personal_data: ['Personal data', 'Data pribadi'],
};

export function exportTypeName(type: ExportRequest['type'] | 'personal_data'): readonly [string, string] {
  return TYPE_NAMES[type];
}

/** The stored spec of a personal data export (Milestone 3 D.6.3): whose data, and the access request it answers. */
export interface PersonalDataSpec {
  type: 'personal_data';
  format: 'json';
  subjectUserId: string;
  privacyRequestId: string | null;
}

/** The spec a task's `params` hold: an export of `POST /exports`, or a personal data export. */
export type StoredExportSpec = ExportSpec | PersonalDataSpec;

/** True for a personal data export. */
export function isPersonalData(spec: StoredExportSpec): spec is PersonalDataSpec {
  return spec.type === 'personal_data';
}

/** Content type of a personal data export. */
export const PERSONAL_DATA_CONTENT_TYPE = 'application/json';

interface TaskRow {
  id: string;
  status: BackgroundTask['status'];
  progress: number;
  result: unknown;
  error: string | null;
  params: unknown;
}

/** The spec stored in a task's `params`. */
export function specOf(params: unknown): StoredExportSpec {
  const raw = (typeof params === 'string' ? JSON.parse(params) : params ?? {}) as Record<string, unknown>;
  if (raw.type === 'personal_data') {
    return { type: 'personal_data', format: 'json', subjectUserId: String(raw.subjectUserId), privacyRequestId: typeof raw.privacyRequestId === 'string' ? raw.privacyRequestId : null };
  }
  const p = raw as Partial<ExportSpec>;
  return { type: p.type!, format: p.format!, ...(p.ms ? { ms: p.ms } : {}) };
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly content: ExportContentService,
    private readonly storage: StorageGatewayContext,
    private readonly files: FileResponder,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(PERMISSION_EVALUATOR) private readonly evaluator: PermissionEvaluator,
  ) {}

  /**
   * Queues the personal data export of `subjectUserId` in the caller's transaction (Milestone 3 D.6.3): a background
   * task of kind `export` whose `params` name the person and the access request, `export.build` (singleton
   * `ex:<taskId>`, 2 retries), audited `export.created` without the person's name. Returns the task id.
   */
  async queuePersonalData(trx: Trx, principal: Principal, spec: { subjectUserId: string; privacyRequestId: string | null; code: string }): Promise<string> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    const stored: PersonalDataSpec = { type: 'personal_data', format: 'json', subjectUserId: spec.subjectUserId, privacyRequestId: spec.privacyRequestId };
    const user = principal.user.id;
    const task = await trx
      .insertInto('background_task')
      .values({ kind: 'export', management_system_id: null, status: 'queued', params: JSON.stringify(stored), created_by: user, updated_by: user })
      .returning('id')
      .executeTakeFirstOrThrow();
    const jobId = await this.jobs.send('export.build', { orgId: org.id, requestedBy: user, payload: { taskId: task.id } }, { singletonKey: `ex:${task.id}`, retryLimit: 2 }, trx);
    if (jobId) await trx.updateTable('background_task').set({ job_id: jobId.slice(0, 80) }).where('id', '=', task.id).execute();
    await this.audit.record(trx, {
      action: 'export.created',
      entityType: 'background_task',
      entityId: task.id,
      entityCode: 'personal_data',
      after: { type: 'personal_data', format: 'json', self: spec.subjectUserId === user, ...(spec.privacyRequestId ? { privacyRequest: spec.code } : {}) },
    });
    return task.id;
  }

  /**
   * Whether the principal may still download a personal data export: the person themselves, or for an access request
   * a holder of `privacy_request.manage` (D.2).
   */
  async personalDataAllowed(principal: Principal, spec: PersonalDataSpec): Promise<boolean> {
    if (spec.subjectUserId === principal.user.id && spec.privacyRequestId === null) return true;
    return (await this.evaluator.evaluate(principal, 'privacy_request.manage', { scope: 'org' })) === 'full';
  }

  /** `POST /exports` (202). */
  async request(principal: Principal, body: ExportRequest): Promise<CommandResult> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    const spec: ExportSpec = { type: body.type, format: body.format, ...(body.ms ? { ms: body.ms } : {}) };
    assertFormat(spec);
    const user = principal.user.id;
    return this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      let msId: string | null = null;
      if (spec.ms) {
        const system = await trx.selectFrom('management_system').select('id').where('slug', '=', spec.ms).where('deleted_at', 'is', null).executeTakeFirst();
        if (!system) throw new NotFoundError('Unknown management system');
        msId = system.id;
      }
      const task = await trx
        .insertInto('background_task')
        .values({ kind: 'export', management_system_id: msId, status: 'queued', params: JSON.stringify(spec), created_by: user, updated_by: user })
        .returning('id')
        .executeTakeFirstOrThrow();
      const jobId = await this.jobs.send('export.build', { orgId: org.id, requestedBy: user, payload: { taskId: task.id } }, { singletonKey: `ex:${task.id}`, retryLimit: 2 }, trx);
      if (jobId) await trx.updateTable('background_task').set({ job_id: jobId.slice(0, 80) }).where('id', '=', task.id).execute();
      await this.audit.record(trx, {
        action: 'export.created',
        msId,
        entityType: 'background_task',
        entityId: task.id,
        entityCode: spec.type,
        after: { ...spec },
      });
      const name = exportTypeName(spec.type);
      return {
        ok: true,
        changed: [],
        taskId: task.id,
        message: [`${name[0]} export queued; you will get a link when it is ready`, `Ekspor ${name[1]} dalam antrean; Anda akan menerima tautan setelah siap`],
      };
    });
  }

  /** `GET /exports/{taskId}`: the creator's export task. */
  async get(principal: Principal, taskId: string): Promise<BackgroundTask> {
    const row = await this.scope.withTenant(tenantContextOf(principal), (trx) => this.task(trx, principal, taskId));
    return {
      id: row.id,
      kind: 'export',
      status: row.status,
      progress: Number(row.progress),
      ...(row.result !== null && row.result !== undefined ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.status === 'succeeded' ? { downloadUrl: exportDownloadUrl(row.id) } : {}),
    };
  }

  private async task(trx: Trx, principal: Principal, taskId: string): Promise<TaskRow> {
    const row = await trx
      .selectFrom('background_task')
      .select(['id', 'status', 'progress', 'result', 'error', 'params'])
      .where('id', '=', taskId)
      .where('kind', '=', 'export')
      .where('created_by', '=', principal.user.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('No such export');
    return row as TaskRow;
  }

  /** `GET /exports/{taskId}/download`: creator only, permission checked again, the file from the vault. */
  async download(reply: FastifyReply, principal: Principal, taskId: string): Promise<FastifyReply> {
    const org = principal.org;
    if (!org) throw new NotFoundError('No organisation is selected');
    const prepared = await this.scope.withTenant(tenantContextOf(principal), async (trx) => {
      const task = await this.task(trx, principal, taskId);
      if (task.status !== 'succeeded') throw new ConflictError('The export is not ready yet');
      const file = await trx
        .selectFrom('export_file')
        .select(['id', 'kind', 'format', 'management_system_id', 'storage_object_id', 'file_name', 'expires_at'])
        .where('background_task_id', '=', task.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!file || !file.storage_object_id || new Date(file.expires_at).getTime() <= this.clock.now().getTime()) {
        throw new NotFoundError('The export file has expired; run the export again');
      }
      const object = await trx.selectFrom('storage_object').selectAll().where('id', '=', file.storage_object_id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!object) throw new NotFoundError('The export file is gone; run the export again');
      const repository = await this.storage.repository(trx, await this.storage.repositoryRow(trx, object.storage_repository_id));
      return { task, file, object, repository, tenant: await this.storage.tenant(trx, org.id) };
    });
    const spec = specOf(prepared.task.params);
    const allowed = isPersonalData(spec) ? await this.personalDataAllowed(principal, spec) : await this.content.allowed(principal, spec);
    if (!allowed) throw new ForbiddenError('You no longer hold the permission this export needs');
    const { object } = prepared;
    const streamed = await this.gateway.stream({
      tenant: prepared.tenant,
      repository: prepared.repository,
      object: {
        externalItemId: object.external_item_id,
        externalVersionId: object.external_version_id,
        hashAlgorithm: object.hash_algorithm,
        hashValue: object.hash_value,
        hashSource: object.hash_source,
        folderPath: object.folder_path,
      },
    });
    const fileName = prepared.file.file_name ?? `export.${prepared.file.format}`;
    return this.files.send(reply, {
      body: streamed.stream,
      storedType: prepared.file.format === 'json' ? PERSONAL_DATA_CONTENT_TYPE : CONTENT_TYPES[prepared.file.format as keyof typeof CONTENT_TYPES],
      fileName,
      size: streamed.size ?? (object.size_bytes === null ? null : Number(object.size_bytes)),
      audit: {
        action: 'export.downloaded',
        msId: prepared.file.management_system_id,
        entityType: 'export_file',
        entityId: prepared.file.id,
        entityCode: fileName,
        after: { type: prepared.file.kind, format: prepared.file.format, fileName, taskId },
      },
    });
  }

  /** `GET /ms/{ms}/applicability/export` and `GET /ms/{ms}/documents/export`, built for the session user. */
  async sheet(reply: FastifyReply, principal: Principal, type: 'soa' | 'document_register', ms: string, format: 'xlsx' | 'csv', lang: Lang): Promise<FastifyReply> {
    const file = await this.content.build(principal, { type, ms, format }, lang);
    return this.files.send(reply, {
      body: file.body,
      storedType: file.contentType,
      fileName: file.fileName,
      size: file.size,
      audit: {
        action: 'export.downloaded',
        msSlug: ms,
        entityType: 'export_file',
        entityCode: file.fileName,
        after: { type, format, fileName: file.fileName, synchronous: true },
      },
    });
  }
}
