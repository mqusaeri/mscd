// Expiry of exports, a tenant step of the hourly `cleanup.expired` (Milestone 3 D.4, A.4): it runs for every
// organisation that is not deleted, also while it is offboarding or closed, and deletes the vault content of expired
// exports through `gateway.objects.delete` (every stored version), which `cleanup.expired` alone never did:
//
// - organisation exports: a ready export whose `expires_at` has passed, and a final export once the organisation is
//   closed (`archived`), become `expired` and their parts and manifest are deleted; a final export of an organisation
//   that went back to `active` or `suspended` gets an expiry `lifecycle.export_link_days` ahead; a request that waited
//   7 days for a decision expires (J.8); an export left `queued` or `building` for `STALE_BUILD_HOURS` while no build
//   runs in the installation (its worker was killed for memory or disk, or both attempts crashed) becomes `failed`
//   (`organization_export.failed`) and the parts it stored are deleted, so a new request can go through;
// - the 7-day `export_file` exports (portfolio board, readiness report, SoA, register, audit trail, personal data):
//   their vault object is deleted; `cleanup.expired` has already marked the row deleted.
//
// A deleted object's `storage_object` row gets `deleted_at`, so the organisation export lists it as removed content.
// The step runs in the organisation's tenant transaction; a gateway error fails it for this organisation, and the next
// hourly run tries again (deleting an object that is gone already is no error).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AUDIT_WRITER, GATEWAY_CLIENT, SYSTEM_USER_ID, type AuditWriter, type GatewayClient, type Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { inPlatformScope } from '../identity/platform-scope';
import { deleteStoredObject } from '../storage/gateway-client';
import { StorageGatewayContext } from '../storage/gateway-context';
import { BUILD_LOCK_CLASS, BUILD_LOCK_KEY } from './build-lock';
import { exportFolder, partsOf } from './builder';
import { exportCode, REQUEST_DECISION_DAYS } from './org-export.service';

/** Name of the `cleanup.expired` step (its count in the job's result). */
export const EXPORTS_EXPIRED_STEP = 'exportsExpired';
/** Organisation statuses the step runs for: every status but `deleted`. */
export const EXPIRY_STATUSES = ['active', 'suspended', 'offboarding', 'archived'] as const;
/** Hours after which an export left `queued` or `building` while no build runs is failed. */
export const STALE_BUILD_HOURS = 24;
/** The reason a stale export fails with. */
export const STALE_BUILD_ERROR =
  `The export stayed queued or building for ${STALE_BUILD_HOURS} hours while no build ran; the worker probably stopped during the build. Request a new export.`;

interface ObjectRow {
  id: string;
  storage_repository_id: string;
  external_item_id: string;
  external_version_id: string | null;
  hash_algorithm: string;
  hash_value: string | null;
  hash_source: string;
  folder_path: string | null;
}

@Injectable()
export class ExportExpiry {
  private readonly logger = new Logger('org-export.expiry');

  constructor(
    private readonly config: MscdConfig,
    private readonly storage: StorageGatewayContext,
    @Inject(GATEWAY_CLIENT) private readonly gateway: GatewayClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** The step: returns the number of exports expired and export files whose content was deleted. */
  async run(trx: Trx, orgId: string, now: Date): Promise<number> {
    const org = await trx.selectFrom('platform.organization').select(['status']).where('id', '=', orgId).executeTakeFirst();
    if (!org || org.status === 'deleted') return 0;
    let count = 0;

    // Requests that waited 7 days for a decision.
    const stale = await inPlatformScope(trx, () =>
      trx
        .updateTable('platform.organization_export')
        .set({ status: 'expired' })
        .where('organization_id', '=', orgId)
        .where('status', '=', 'requested')
        .where('requested_at', '<=', new Date(now.getTime() - REQUEST_DECISION_DAYS * 86_400_000))
        .executeTakeFirst(),
    );
    count += Number(stale.numUpdatedRows);

    count += await this.failStaleBuilds(trx, orgId, now);

    // A final export of an organisation that is active again keeps the usual link time from now on.
    if (org.status === 'active' || org.status === 'suspended') {
      await trx
        .updateTable('platform.organization_export')
        .set({ expires_at: new Date(now.getTime() + this.config.profile.lifecycle.export_link_days * 86_400_000) })
        .where('organization_id', '=', orgId)
        .where('status', '=', 'ready')
        .where('is_final', '=', true)
        .where('expires_at', 'is', null)
        .execute();
    }

    const expired = await trx
      .selectFrom('platform.organization_export')
      .select(['id', 'parts', 'manifest_object_id'])
      .where('organization_id', '=', orgId)
      .where('status', '=', 'ready')
      .where((eb) =>
        org.status === 'archived'
          ? eb.or([eb('expires_at', '<=', now), eb('is_final', '=', true)])
          : eb('expires_at', '<=', now),
      )
      .forUpdate()
      .execute();
    for (const row of expired) {
      const ids = [...partsOf(row.parts).flatMap((p) => (p.storageObjectId ? [p.storageObjectId] : [])), ...(row.manifest_object_id ? [row.manifest_object_id] : [])];
      await this.deleteContent(trx, orgId, ids, now);
      await inPlatformScope(trx, () => trx.updateTable('platform.organization_export').set({ status: 'expired' }).where('id', '=', row.id).execute());
      count += 1;
    }

    // The 7-day export files whose vault object still exists.
    const { rows: files } = await sql<{ storage_object_id: string }>`
      select ef.storage_object_id from export_file ef join storage_object so on so.id = ef.storage_object_id
      where ef.expires_at <= ${now} and so.deleted_at is null`.execute(trx);
    if (files.length > 0) {
      await this.deleteContent(trx, orgId, files.map((f) => f.storage_object_id), now);
      await trx
        .updateTable('export_file')
        .set({ deleted_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
        .where('storage_object_id', 'in', files.map((f) => f.storage_object_id))
        .where('deleted_at', 'is', null)
        .execute();
      count += files.length;
    }
    return count;
  }

  /**
   * Fails the exports of the organisation left `queued` or `building` for `STALE_BUILD_HOURS` (by `updated_at`, which
   * the claim sets) while no build runs: the step takes the installation's build lock for its transaction
   * (`pg_try_advisory_xact_lock`, the key of `build-lock.ts`), so no build can claim or finish such a row meanwhile;
   * when a build holds it, the step leaves the rows for a later run. The parts a failed attempt stored are deleted.
   */
  private async failStaleBuilds(trx: Trx, orgId: string, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_BUILD_HOURS * 3_600_000);
    const candidates = await trx
      .selectFrom('platform.organization_export')
      .select('id')
      .where('organization_id', '=', orgId)
      .where('status', 'in', ['queued', 'building'])
      .where('updated_at', '<=', cutoff)
      .execute();
    if (candidates.length === 0) return 0;
    const { rows: lock } = await sql<{ ok: boolean }>`select pg_try_advisory_xact_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY}) as ok`.execute(trx);
    if (!lock[0]?.ok) return 0;
    const stale = await trx
      .selectFrom('platform.organization_export')
      .select(['id', 'status', 'requested_at'])
      .where('id', 'in', candidates.map((c) => c.id))
      .where('status', 'in', ['queued', 'building'])
      .where('updated_at', '<=', cutoff)
      .forUpdate()
      .execute();
    for (const row of stale) {
      const { rows: objects } = await sql<{ id: string }>`
        select id from storage_object where folder_path = ${exportFolder(row.id)} and deleted_at is null`.execute(trx);
      await this.deleteContent(trx, orgId, objects.map((o) => o.id), now);
      await inPlatformScope(trx, () =>
        trx.updateTable('platform.organization_export').set({ status: 'failed', error: STALE_BUILD_ERROR }).where('id', '=', row.id).execute(),
      );
      await this.audit.record(trx, {
        action: 'organization_export.failed',
        actor: { userId: SYSTEM_USER_ID, kind: 'system' },
        entityType: 'organization_export',
        entityId: row.id,
        entityCode: exportCode(row.requested_at),
        before: { status: row.status },
        after: { status: 'failed', error: STALE_BUILD_ERROR, staleAfterHours: STALE_BUILD_HOURS },
      });
      this.logger.warn({ orgId, exportId: row.id, status: row.status }, 'A stale organisation export was failed');
    }
    return stale.length;
  }

  /** Deletes the vault objects (every version) and marks their rows deleted. */
  private async deleteContent(trx: Trx, orgId: string, ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    const objects = (await trx
      .selectFrom('storage_object')
      .select(['id', 'storage_repository_id', 'external_item_id', 'external_version_id', 'hash_algorithm', 'hash_value', 'hash_source', 'folder_path'])
      .where('id', 'in', [...ids])
      .where('deleted_at', 'is', null)
      .execute()) as ObjectRow[];
    if (objects.length === 0) return;
    const tenant = await this.storage.tenant(trx, orgId);
    const repositories = new Map<string, Awaited<ReturnType<StorageGatewayContext['repository']>>>();
    for (const object of objects) {
      let repository = repositories.get(object.storage_repository_id);
      if (!repository) {
        const row = await trx.selectFrom('storage_repository').selectAll().where('id', '=', object.storage_repository_id).executeTakeFirstOrThrow();
        repository = await this.storage.repository(trx, row, { withCredential: false });
        repositories.set(object.storage_repository_id, repository);
      }
      const result = await deleteStoredObject(this.gateway, {
        tenant,
        repository,
        object: {
          externalItemId: object.external_item_id,
          externalVersionId: object.external_version_id,
          hashAlgorithm: object.hash_algorithm as 'sha256',
          hashValue: object.hash_value,
          hashSource: object.hash_source as 'computed',
          folderPath: object.folder_path,
        },
      });
      if (!result.deleted) this.logger.warn({ orgId, objectId: object.id }, 'An expired export object was already gone from the vault');
    }
    await trx
      .updateTable('storage_object')
      .set({ deleted_at: now, updated_at: now, updated_by: SYSTEM_USER_ID })
      .where('id', 'in', objects.map((o) => o.id))
      .execute();
  }
}
