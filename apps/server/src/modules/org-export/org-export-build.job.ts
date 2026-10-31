// `org-export.build` (Milestone 3 J.3, D.4; payload `{exportId}`, singleton key `oe:<exportId>`, one retry): builds
// the parts and the manifest of one organisation export and stores them in the organisation's Managed Vault.
//
// 1. Claim: the export row of the organisation is locked; a `queued` row (also the final export that the move to
//    `offboarding` queues by inserting a row and sending this job), or a `building` or `failed` row of an earlier
//    attempt, becomes `building`. Any other status is left alone. Objects an earlier attempt left in the vault are
//    deleted first. The organisation must be `active` or `offboarding`, else the export fails.
// 2. Checks: the stored files against `lifecycle.export_max_bytes` (`export_too_large`), and the free space of the
//    worker's temporary folder (`TMPDIR`) against one part.
// 3. Build (`OrgExportBuilder`): each closed part is uploaded to `exports/organization/<exportId>/` of the vault, recorded
//    as a `storage_object`, checked against the SHA-256 the gateway computed, and deleted from the folder before the next
//    part starts; then the full manifest is stored the same way.
// 4. Complete, in one transaction: the row becomes `ready` with its parts, counts, manifest and expiry
//    (`lifecycle.export_link_days` after it is ready; a final export has none and stays until the organisation leaves
//    `offboarding`), the audit entry `organization_export.built`, and `organization_export_ready` to the requester, or to
//    every Tenant Admin for an export of the provider or the final export.
//
// A failure deletes the parts already stored, marks the row `failed` with the reason (`organization_export.failed`) and
// is thrown again, so the queue retries once; a retry starts again from step 1. A build that dies without reaching that
// step (the worker killed for memory or disk) leaves the row `queued` or `building`: the expiry of `cleanup.expired`
// fails it after 24 hours while no build runs (`expiry.ts`), and step 4 only completes a row that is still `building`.
//
// One build runs at a time in the installation (D.4), whatever the number of worker processes: the build holds the
// session advisory lock of `build-lock.ts`. A job that finds it held changes nothing and sends itself again
// `BUILD_BUSY_RETRY_SECONDS` later (outcome `busy`).
//
// The working folder is in the worker's temporary folder (`TMPDIR`): the scratch volume of Compose (`worker-tmp`) and
// the `emptyDir` of the Helm worker, which keep their content across a restart of the worker. A build that died leaves
// its folder there, so each build first removes the folders of earlier builds that nobody touched for
// `STALE_BUILD_HOURS`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PutResult } from '@mscd/shared';
import { Clock } from '../../common/clock';
import { JobHandler, type JobHandlerInstance } from '../../common/jobs/job-handler';
import type { JobRun } from '../../common/jobs/job-queue';
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
  type TenantInfo,
  type Trx,
} from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import { inPlatformScope } from '../identity/platform-scope';
import { deleteStoredObject } from '../storage/gateway-client';
import { StorageGatewayContext } from '../storage/gateway-context';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope, systemContextOf } from '../tenancy/tenant-scope';
import { BUILD_BUSY_RETRY_SECONDS, withBuildLock } from './build-lock';
import { checkFreeSpace, exportFolder, exportTooLarge, OrgExportBuilder, storedFileBytes, type BuildResult, type StoredPart } from './builder';
import { STALE_BUILD_HOURS } from './expiry';
import { notifyAll, readyNotice } from './notices';
import { exportCode } from './org-export.service';
import { activeTenantAdmins, exportPeople, nameOf } from './people';

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

export interface OrgExportBuildOptions {
  /** Largest part in bytes (default `lifecycle.export_part_bytes`; tests use small parts). */
  partBytes?: number;
  requestId?: string;
}

export interface OrgExportBuildOutcome {
  exportId: string;
  /** `busy`: another build held the installation's lock; the job was sent again for later. */
  status: 'ready' | 'failed' | 'skipped' | 'busy';
  parts?: number;
  files?: number;
  sizeBytes?: number;
  error?: string;
}

interface Claimed {
  org: TenantInfo;
  requestedVia: string;
  requestedBy: string | null;
  isFinal: boolean;
  requesterHandle: string | null;
  approverHandle: string | null;
  requestedAt: Date;
  leftovers: StoredObjectRef[];
}

/** A stored object the job may have to delete again. */
interface StoredObjectRef {
  id: string;
  repositoryId: string;
  externalItemId: string;
}

/** A failure that another attempt cannot fix: the export fails without a retry. */
class FinalExportError extends Error {}

/** Prefix of the working folders of builds in the worker's temporary folder. */
export const WORK_DIR_PREFIX = 'mscd-org-export-';

/**
 * Removes the working folders of earlier builds that nobody touched for `STALE_BUILD_HOURS` (a build adds a file to
 * its folder for every table and part). Runs while the build holds the installation's lock; best effort.
 */
export async function removeStaleWorkDirs(root: string, logger: Logger, nowMs = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  const cutoff = nowMs - STALE_BUILD_HOURS * 3_600_000;
  for (const name of names) {
    if (!name.startsWith(WORK_DIR_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
      logger.warn({ dir }, 'org-export.build removed the working folder of an earlier build that stopped');
    } catch (error) {
      logger.warn({ dir }, `org-export.build could not remove an old working folder: ${errorText(error)}`);
    }
  }
  return removed;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

@Injectable()
@JobHandler('org-export.build', { concurrency: 1, scope: 'tenant' })
export class OrgExportBuildJob implements JobHandlerInstance<'org-export.build'> {
  private readonly logger = new Logger('org-export.build');

  constructor(
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly clock: Clock,
    private readonly config: MscdConfig,
    private readonly builder: OrgExportBuilder,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(DATABASE) private readonly db: AppDatabase,
  ) {}

  async handle(job: JobRun<'org-export.build'>): Promise<void> {
    const outcome = await this.build(job.env.orgId, job.env.payload.exportId, { requestId: job.env.requestId });
    this.logger.log({ jobId: job.id, orgId: job.env.orgId, attempt: job.attempt, ...outcome }, 'org-export.build done');
  }

  /**
   * Builds one export (D.4) while holding the installation's build lock. When another build holds it, nothing changes
   * and the job is sent again for later (a singleton key of its own, because this run still holds `oe:<exportId>`).
   * Throws after recording a failure that another attempt may fix.
   */
  async build(orgId: string | null, exportId: string, options: OrgExportBuildOptions = {}): Promise<OrgExportBuildOutcome> {
    if (!orgId) throw new Error('org-export.build needs the organisation of the job envelope');
    // eslint-disable-next-line no-restricted-syntax -- the pool only pins the connection of the session lock (build-lock.ts)
    const run = await withBuildLock(this.db, () => this.buildLocked(orgId, exportId, options));
    if (run.locked) return run.value;
    await this.jobs.send(
      'org-export.build',
      { orgId, ...(options.requestId ? { requestId: options.requestId } : {}), payload: { exportId } },
      { singletonKey: `oe:${exportId}:wait:${this.clock.now().getTime()}`, startAfterSeconds: BUILD_BUSY_RETRY_SECONDS, retryLimit: 1 },
    );
    this.logger.log({ orgId, exportId, retryInSeconds: BUILD_BUSY_RETRY_SECONDS }, 'org-export.build: another export is being built; queued again');
    return { exportId, status: 'busy' };
  }

  private async buildLocked(orgId: string, exportId: string, options: OrgExportBuildOptions): Promise<OrgExportBuildOutcome> {
    const org = await this.tenants.resolveById(orgId);
    if (!org) return { exportId, status: 'skipped' };
    const context = systemContextOf(org, options.requestId);
    const claimed = await this.scope.withTenant(context, (trx) => this.claim(trx, org, exportId));
    if (!claimed) return { exportId, status: 'skipped' };
    if (claimed === 'inactive') {
      const error = `The organisation is ${org.status}; an export runs while it is active or offboarding`;
      await this.scope.withTenant(context, (trx) => this.fail(trx, exportId, error));
      return { exportId, status: 'failed', error };
    }
    const stored: StoredObjectRef[] = [];
    let workDir: string | null = null;
    try {
      await this.deleteObjects(org, claimed.leftovers, options.requestId);
      const limit = this.config.profile.lifecycle.export_max_bytes;
      const fileBytes = await this.scope.withTenant(context, (trx) => storedFileBytes(trx, org.id));
      if (fileBytes > limit) throw new FinalExportError(exportTooLarge(fileBytes, limit).message);
      const partBytes = options.partBytes ?? this.config.profile.lifecycle.export_part_bytes;
      await removeStaleWorkDirs(os.tmpdir(), this.logger);
      workDir = await mkdtemp(path.join(os.tmpdir(), `${WORK_DIR_PREFIX}${exportId.slice(0, 8)}-`));
      await checkFreeSpace(workDir, await this.builder.neededSpace(org, partBytes));
      const now = this.clock.now();
      const parts: StoredPart[] = [];
      const result = await this.builder.build({
        org,
        exportId,
        requestedVia: claimed.requestedVia,
        requestedBy: claimed.requesterHandle,
        approvedBy: claimed.approverHandle,
        isFinal: claimed.isFinal,
        workDir,
        partBytes,
        now,
        localDate: this.clock.todayIn(org.timeZone),
        requestId: options.requestId,
        onPart: async (part) => {
          const object = await this.store(org, exportId, part.name, () => createReadStream(part.path), part.sizeBytes, part.sha256, options.requestId);
          stored.push(object);
          parts.push({ part: part.part, name: part.name, sizeBytes: part.sizeBytes, sha256: part.sha256, storageObjectId: object.id });
          await rm(part.path, { force: true });
        },
      });
      const manifestName = `${result.baseName}-manifest.json`;
      const manifestSha = sha256Hex(result.manifestBytes);
      const manifest = await this.store(org, exportId, manifestName, () => Readable.from([result.manifestBytes]), result.manifestBytes.length, manifestSha, options.requestId);
      stored.push(manifest);
      await this.scope.withTenant(context, (trx) => this.complete(trx, exportId, claimed, result, parts, manifest.id, manifestSha));
      return { exportId, status: 'ready', parts: parts.length, files: result.fileCount, sizeBytes: result.sizeBytes };
    } catch (error) {
      const message = errorText(error);
      this.logger.error({ orgId, exportId }, `org-export.build failed: ${message}`);
      await this.deleteObjects(org, stored, options.requestId).catch((cleanup: unknown) =>
        this.logger.error({ orgId, exportId }, `org-export.build could not delete the parts of the failed attempt: ${errorText(cleanup)}`),
      );
      await this.scope.withTenant(context, (trx) => this.fail(trx, exportId, message));
      if (error instanceof FinalExportError) return { exportId, status: 'failed', error: message };
      throw error;
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Step 1: the row becomes `building`; null when there is nothing to build, `inactive` when the organisation is not usable. */
  private async claim(trx: Trx, org: TenantInfo, exportId: string): Promise<Claimed | 'inactive' | null> {
    const row = await trx
      .selectFrom('platform.organization_export')
      .select(['id', 'status', 'requested_via', 'requested_by', 'decided_by', 'is_final', 'requested_at'])
      .where('id', '=', exportId)
      .where('organization_id', '=', org.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      this.logger.warn({ orgId: org.id, exportId }, 'org-export.build: no such export');
      return null;
    }
    if (row.status !== 'queued' && row.status !== 'building' && row.status !== 'failed') return null;
    if (org.status !== 'active' && org.status !== 'offboarding') return 'inactive';
    if (row.status === 'failed') {
      const other = await trx
        .selectFrom('platform.organization_export')
        .select('id')
        .where('organization_id', '=', org.id)
        .where('id', '<>', row.id)
        .where('status', 'in', ['queued', 'building'])
        .executeTakeFirst();
      if (other) return null;
    }
    const leftovers = await trx
      .selectFrom('storage_object')
      .select(['id', 'storage_repository_id', 'external_item_id'])
      .where('folder_path', '=', exportFolder(exportId))
      .where('deleted_at', 'is', null)
      .execute();
    await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.organization_export')
        .set({ status: 'building', error: null, part_count: null, file_count: null, size_bytes: null, parts: null, manifest_object_id: null, manifest_sha256: null })
        .where('id', '=', row.id)
        .execute(),
    );
    const people = await exportPeople(trx, org.id, [row.requested_by, row.decided_by]);
    return {
      org,
      requestedVia: row.requested_via,
      requestedBy: row.requested_by,
      isFinal: row.is_final,
      requesterHandle: row.requested_via === 'tenant_admin' ? (nameOf(people, row.requested_by)?.handle ?? null) : null,
      approverHandle: nameOf(people, row.decided_by)?.handle ?? null,
      requestedAt: row.requested_at,
      leftovers: leftovers.map((o) => ({ id: o.id, repositoryId: o.storage_repository_id, externalItemId: o.external_item_id })),
    };
  }

  /** `PUT /v1/objects` of one part or the manifest into the organisation's Managed Vault, recorded as a storage object. */
  private async store(
    org: TenantInfo,
    exportId: string,
    fileName: string,
    body: () => Readable,
    sizeBytes: number,
    sha256: string,
    requestId?: string,
  ): Promise<StoredObjectRef> {
    const context = systemContextOf(org, requestId);
    const target = await this.scope.withTenant(context, async (trx) => {
      const row = await trx
        .selectFrom('storage_repository')
        .selectAll()
        .where('adapter', '=', 'managed_vault')
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .orderBy('slug')
        .executeTakeFirst();
      if (!row) throw new FinalExportError('The organisation has no Managed Vault to hold the export');
      return { row, descriptor: await this.storage.repository(trx, row, { withCredential: false }), tenant: await this.storage.tenant(trx, org.id) };
    });
    const header = {
      tenant: target.tenant,
      repository: target.descriptor,
      scopeRoot: { folderId: null, path: '' },
      folderPath: exportFolder(exportId),
      fileName,
      maxBytes: Math.max(1, sizeBytes),
      metadataMinimization: target.row.metadata_minimization,
    };
    const result = await this.gateway.putObject<PutResult>(header, body(), requestId ? { requestId } : undefined);
    const now = this.clock.now();
    const object = await this.scope.withTenant(context, (trx) =>
      trx
        .insertInto('storage_object')
        .values({
          storage_repository_id: target.row.id,
          external_item_id: result.externalItemId,
          external_version_id: result.externalVersionId,
          version_label: result.versionLabel.slice(0, 30),
          display_name: fileName,
          mime_type: fileName.endsWith('.json') ? 'application/json' : 'application/gzip',
          size_bytes: String(result.sizeBytes),
          hash_algorithm: 'sha256',
          hash_value: result.hashValue,
          hash_source: 'computed',
          provider_created_at: result.providerCreatedAt ? new Date(result.providerCreatedAt) : now,
          provider_modified_at: result.providerCreatedAt ? new Date(result.providerCreatedAt) : now,
          folder_path: exportFolder(exportId),
          encryption: result.encryption ? JSON.stringify(result.encryption) : null,
          link_status: 'intact',
          link_status_since: now,
          last_verified_at: now,
          last_good_check_at: now,
          created_by: SYSTEM_USER_ID,
          updated_by: SYSTEM_USER_ID,
        } as never)
        .returning(['id'])
        .executeTakeFirstOrThrow(),
    );
    const ref = { id: object.id, repositoryId: target.row.id, externalItemId: result.externalItemId };
    if (result.hashValue !== sha256 || result.sizeBytes !== sizeBytes) {
      await this.deleteObjects(org, [ref], requestId);
      throw new Error(`The vault stored ${fileName} with ${result.sizeBytes} bytes and SHA-256 ${result.hashValue}, not ${sizeBytes} bytes and ${sha256}`);
    }
    return ref;
  }

  /** Deletes stored export objects from the vault (`gateway.objects.delete`) and marks their rows deleted. */
  private async deleteObjects(org: TenantInfo, objects: readonly StoredObjectRef[], requestId?: string): Promise<void> {
    if (objects.length === 0) return;
    const context = systemContextOf(org, requestId);
    const { tenant, repositories } = await this.scope.withTenant(context, async (trx) => {
      const repositories = new Map<string, Awaited<ReturnType<StorageGatewayContext['repository']>>>();
      for (const id of new Set(objects.map((o) => o.repositoryId))) {
        const row = await trx.selectFrom('storage_repository').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
        repositories.set(id, await this.storage.repository(trx, row, { withCredential: false }));
      }
      return { tenant: await this.storage.tenant(trx, org.id), repositories };
    });
    for (const object of objects) {
      await deleteStoredObject(
        this.gateway,
        {
          tenant,
          repository: repositories.get(object.repositoryId)!,
          object: { externalItemId: object.externalItemId, externalVersionId: null, hashAlgorithm: 'sha256', hashValue: null, hashSource: 'computed', folderPath: null },
        },
        requestId ? { requestId } : {},
      );
    }
    const now = this.clock.now();
    await this.scope.withTenant(context, (trx) =>
      trx
        .updateTable('storage_object')
        .set({ deleted_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
        .where('id', 'in', objects.map((o) => o.id))
        .execute(),
    );
  }

  /** Step 4, in one transaction. */
  private async complete(trx: Trx, exportId: string, claimed: Claimed, result: BuildResult, parts: StoredPart[], manifestObjectId: string, manifestSha: string): Promise<void> {
    const now = this.clock.now();
    const days = this.config.profile.lifecycle.export_link_days;
    const expiresAt = claimed.isFinal ? null : new Date(now.getTime() + days * 86_400_000);
    const updated = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.organization_export')
        .set({
          status: 'ready',
          part_count: parts.length,
          file_count: result.fileCount,
          size_bytes: String(result.sizeBytes),
          parts: JSON.stringify(parts),
          manifest_object_id: manifestObjectId,
          manifest_sha256: manifestSha,
          expires_at: expiresAt,
          completed_at: now,
          error: null,
        })
        .where('id', '=', exportId)
        .where('status', '=', 'building')
        .executeTakeFirst(),
    );
    // The expiry fails an export left building for a day while no build holds the lock; such a row is never made ready.
    if (Number(updated.numUpdatedRows) === 0) throw new FinalExportError('The export is no longer building (the expiry marked it failed); request a new export');
    const code = exportCode(claimed.requestedAt);
    await this.audit.record(trx, {
      action: 'organization_export.built',
      actor: SYSTEM_ACTOR,
      entityType: 'organization_export',
      entityId: exportId,
      entityCode: code,
      after: {
        status: 'ready',
        parts: parts.map((p) => ({ part: p.part, name: p.name, sizeBytes: p.sizeBytes, sha256: p.sha256 })),
        manifestSha256: manifestSha,
        files: result.fileCount,
        sizeBytes: result.sizeBytes,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    const admins = await activeTenantAdmins(trx, claimed.org.id);
    const recipients =
      claimed.requestedVia === 'tenant_admin' && claimed.requestedBy && admins.includes(claimed.requestedBy) ? [claimed.requestedBy] : admins;
    await notifyAll(this.notifications, trx, recipients, {
      kind: 'organization_export_ready',
      ...readyNotice(parts.length, result.sizeBytes, expiresAt ? expiresAt.toISOString().slice(0, 10) : null),
      id: exportId,
      code,
    });
  }

  private async fail(trx: Trx, exportId: string, error: string): Promise<void> {
    const updated = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.organization_export')
        .set({ status: 'failed', error })
        .where('id', '=', exportId)
        .where('status', 'in', ['queued', 'building'])
        .returning(['requested_at'])
        .executeTakeFirst(),
    );
    if (!updated) return;
    await this.audit.record(trx, {
      action: 'organization_export.failed',
      actor: SYSTEM_ACTOR,
      entityType: 'organization_export',
      entityId: exportId,
      entityCode: exportCode(updated.requested_at),
      after: { status: 'failed', error },
    });
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
